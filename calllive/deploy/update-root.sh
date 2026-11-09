#!/bin/bash
# Execute locally as root AFTER Module Admin installed this version.
# All installed-module files are read-only inputs; secrets/backups stay on the PBX.
set -Eeuo pipefail
umask 027
export PYTHONDONTWRITEBYTECODE=1
cl_version=15.0.9
cl_collector_version=15.0.8
cl_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cl_backup_root=/var/backups/freepbx-calllive
cl_paths=(/opt/freepbx-calllive/collector.py /opt/freepbx-calllive/telemetry.py /opt/freepbx-calllive/release.json /etc/systemd/system/freepbx-calllive.service /etc/freepbx-calllive.env /etc/asterisk/manager_calllive.conf /etc/asterisk/manager_custom.conf)
cl_mutated=0
cl_backup=''
cl_was_active=0
cl_new_user=0

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
[ "$EUID" -eq 0 ] || die 'Запустите эту команду от root.'
command -v flock >/dev/null || die 'Нужна команда flock (util-linux).'
exec 9>/run/calllive-update.lock
flock -n 9 || die 'Обновление CallLive уже выполняется.'
command -v systemctl >/dev/null || die 'Нужен systemd.'
command -v asterisk >/dev/null || die 'Команда asterisk не найдена в PATH.'

restore_backup() {
    local cl_restore="$1" cl_target cl_rel
    [ -d "$cl_restore/files" ] && [ -f "$cl_restore/manifest" ] || return 1
    # Only fixed destinations are restored; never evaluate backup contents.
    for cl_target in "${cl_paths[@]}"; do
        cl_rel="${cl_target#/}"
        if [ -f "$cl_restore/files/$cl_rel" ]; then
            install -d "$(dirname -- "$cl_target")" || return 1
            cp -p -- "$cl_restore/files/$cl_rel" "$cl_target.calllive-restore" || return 1
            mv -f -- "$cl_target.calllive-restore" "$cl_target" || return 1
            cmp -s -- "$cl_restore/files/$cl_rel" "$cl_target" || return 1
        elif grep -Fxq -- "$cl_target absent" "$cl_restore/manifest"; then
            rm -f -- "$cl_target" || return 1
        fi
    done
    systemctl daemon-reload || return 1
    asterisk -rx 'manager reload' >/dev/null || return 1
    if [ -f "$cl_restore/was-enabled" ] && [ "$(cat "$cl_restore/was-enabled")" = 0 ]; then
        systemctl disable freepbx-calllive.service >/dev/null 2>&1 || true
    fi
    if [ "$(cat "$cl_restore/was-active")" = 1 ]; then systemctl restart freepbx-calllive.service || return 1;
    else systemctl stop freepbx-calllive.service >/dev/null 2>&1 || true; fi
    for cl_target in "${cl_paths[@]}"; do
        cl_rel="${cl_target#/}"
        if [ -f "$cl_restore/files/$cl_rel" ]; then
            cmp -s -- "$cl_restore/files/$cl_rel" "$cl_target" || return 1
        elif grep -Fxq -- "$cl_target absent" "$cl_restore/manifest"; then
            [ ! -e "$cl_target" ] || return 1
        fi
    done
}

if [ "${1:-}" = --rollback ]; then
    [ "$#" -eq 2 ] || die 'Использование: update-root.sh --rollback /var/backups/freepbx-calllive/КАТАЛОГ'
    cl_restore_path="$(realpath -e -- "$2")"
    case "$cl_restore_path" in "$cl_backup_root"/*) ;; *) die 'Укажите резервную копию CallLive из /var/backups/freepbx-calllive.';; esac
    [ "$(stat -c %u "$cl_restore_path")" = 0 ] || die 'Каталог резервной копии должен принадлежать root.'
    restore_backup "$cl_restore_path" || die 'Не удалось полностью восстановить службу. Проверьте журнал и файлы резервной копии.'
    say 'Файлы сборщика восстановлены. История вызовов сохранена. Проверьте статус службы.'
    exit 0
fi
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --check-only ]; }; then
    die 'Допустимы --check-only или --rollback КАТАЛОГ.'
fi

[ -f /etc/freepbx.conf ] || die 'FreePBX не обнаружен: нет /etc/freepbx.conf.'
command -v php >/dev/null || die 'Нужен PHP CLI FreePBX.'
php -r '$bootstrap_settings["freepbx_auth"]=false; $bootstrap_settings["skip_astman"]=true; require "/etc/freepbx.conf"; if (!version_compare(getVersion(),"15.0",">=") || version_compare(getVersion(),"16.0",">=")) exit(1);' \
    >/dev/null || die 'Этот релиз предназначен для FreePBX 15.'
[ -f "$cl_source/deploy/files.sha256" ] || die 'Нет контрольных сумм релиза. Загрузите полный архив через Module Admin.'
(cd "$cl_source" && sha256sum --quiet -c deploy/files.sha256) || die 'Файлы установленного модуля не совпадают с релизом.'
grep -Fq "<version>$cl_version</version>" "$cl_source/module.xml" || die 'Версия module.xml не совпадает.'
getent group asterisk >/dev/null || die 'Группа asterisk не найдена. Проверьте пути и пользователя установки FreePBX.'
[ -f /etc/asterisk/manager.conf ] || die 'Не найден manager.conf Asterisk.'
grep -Eq '^[[:space:]]*#include[[:space:]]+"?manager_custom\.conf"?([[:space:]]|$)' /etc/asterisk/manager.conf \
    || die 'В manager.conf должен подключаться manager_custom.conf. Настройте включение перед установкой.'

cl_exec="$(systemctl show -p ExecStart freepbx-calllive.service 2>/dev/null | sed -n 's/^ExecStart=//p' || true)"
cl_current_python=''
if [[ "$cl_exec" =~ path=([^\ \;\}]+) ]]; then cl_current_python="${BASH_REMATCH[1]}"; fi
cl_python=''
for cl_candidate in "$cl_current_python" /usr/bin/python3 /usr/bin/python3.6 /usr/local/bin/python3; do
    if [ -n "$cl_candidate" ] && [ -x "$cl_candidate" ] && "$cl_candidate" -c 'import sys; assert sys.version_info >= (3,6)' >/dev/null 2>&1; then
        cl_python="$cl_candidate"; break
    fi
done
[ -n "$cl_python" ] || die 'Нужен установленный Python 3.6 или новее. Поддерживается /usr/bin/python3.6; пакеты Python не заменяются.'
"$cl_python" - "$cl_source/deploy" "$cl_collector_version" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1])
for name in ('collector.py', 'telemetry.py'):
    compile((source / name).read_text(encoding='utf-8'), str(source / name), 'exec')
sys.path.insert(0, str(source))
import telemetry
assert telemetry.VERSION == sys.argv[2]
PY
say "Проверены FreePBX 15, файлы CallLive $cl_version и $cl_python."

if [ "${1:-}" = --check-only ]; then
    if [ -f /etc/freepbx-calllive.env ]; then
        set -a; . /etc/freepbx-calllive.env; set +a
        "$cl_python" "$cl_source/deploy/collector.py" --check
    else say 'Первичная установка: учётная запись AMI будет создана при запуске без --check-only.'; fi
    say 'Проверка завершена; файлы и служба не изменены.'
    exit 0
fi

install -d -m 0700 -o root -g root "$cl_backup_root"
cl_backup="$(mktemp -d "$cl_backup_root/$cl_version-$(date +%Y%m%d-%H%M%S).XXXXXXXX")"
chmod 0700 "$cl_backup"
systemctl is-active --quiet freepbx-calllive.service && cl_was_active=1 || true
printf '%s\n' "$cl_was_active" > "$cl_backup/was-active"
if systemctl is-enabled --quiet freepbx-calllive.service; then printf '1\n' > "$cl_backup/was-enabled";
else printf '0\n' > "$cl_backup/was-enabled"; fi
: > "$cl_backup/manifest"
for cl_target in "${cl_paths[@]}"; do
    if [ -e "$cl_target" ]; then
        [ -f "$cl_target" ] && [ ! -L "$cl_target" ] || die "Ожидался обычный файл: $cl_target"
        install -d -m 0700 "$cl_backup/files/$(dirname -- "${cl_target#/}")"
        cp -p -- "$cl_target" "$cl_backup/files/${cl_target#/}"
        printf '%s present\n' "$cl_target" >> "$cl_backup/manifest"
    else printf '%s absent\n' "$cl_target" >> "$cl_backup/manifest"; fi
done
on_error() {
    local cl_error=$?
    trap - EXIT
    [ "$cl_error" -ne 0 ] || return 0
    if [ "$cl_mutated" = 1 ]; then
        say 'Проверка обновления не прошла. Возвращаю предыдущие файлы сборщика.' >&2
        if restore_backup "$cl_backup"; then say 'Предыдущая версия файлов восстановлена.' >&2;
        else say "Автоматический откат не завершён. Резервная копия: $cl_backup" >&2; fi
    fi
    say "Обновление не завершено. Резервная копия: $cl_backup" >&2
    exit "$cl_error"
}
trap on_error EXIT
cl_mutated=1

if ! id -u freepbx-calllive >/dev/null 2>&1; then
    useradd --system --no-create-home --gid asterisk --shell /sbin/nologin freepbx-calllive
    cl_new_user=1
fi
cl_run_user="$(systemctl show -p User freepbx-calllive.service 2>/dev/null | sed -n 's/^User=//p' || true)"
cl_run_group="$(systemctl show -p Group freepbx-calllive.service 2>/dev/null | sed -n 's/^Group=//p' || true)"
cl_run_user="${cl_run_user:-freepbx-calllive}"
cl_run_group="${cl_run_group:-asterisk}"
[ "$cl_run_user" != root ] || die 'Служба сборщика должна работать от отдельного непривилегированного пользователя.'
[ "$(id -u "$cl_run_user")" != 0 ] || die 'Пользователь службы не должен иметь UID 0.'
getent group "$cl_run_group" >/dev/null

if [ ! -f /etc/freepbx-calllive.env ]; then
    [ ! -e /etc/asterisk/manager_calllive.conf ] || die 'Есть manager_calllive.conf, но отсутствует окружение службы. Восстановите действующую пару файлов.'
    "$cl_python" - <<'PY'
import os, secrets
path='/etc/freepbx-calllive.env'
fd=os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write('CALLLIVE_AMI_USER=freepbx-calllive\nCALLLIVE_AMI_PORT=5038\nCALLLIVE_AMI_SECRET=' + secrets.token_hex(32) + '\n')
PY
fi
[ "$(stat -c %u /etc/freepbx-calllive.env)" = 0 ] || die 'Файл /etc/freepbx-calllive.env должен принадлежать root.'
chmod 0600 /etc/freepbx-calllive.env
set -a; . /etc/freepbx-calllive.env; set +a

# Add only required event classes to the module's own AMI file; custom accounts
# are validated through --check and reported without overwriting their ACLs.
"$cl_python" - <<'PY'
import os, pathlib, re
path=pathlib.Path('/etc/asterisk/manager_calllive.conf')
user=os.environ.get('CALLLIVE_AMI_USER', 'freepbx-calllive')
secret=os.environ.get('CALLLIVE_AMI_SECRET', '')
if user != 'freepbx-calllive':
    print('Собственная учётная запись AMI: добавьте read=call,agent и события очередей/переводов в её eventfilter при необходимости.')
else:
    events='Newchannel|Newstate|NewCallerid|NewConnectedLine|Hangup|DialBegin|DialEnd|BridgeCreate|BridgeDestroy|BridgeEnter|BridgeLeave|BridgeMerge|ExtensionStatus|Hold|Unhold|ParkedCall|UnParkedCall|ParkedCallTimeOut|ParkedCallGiveUp|BlindTransfer|AttendedTransfer|QueueCallerJoin|QueueCallerLeave|AgentConnect|AgentComplete'
    if not path.exists():
        assert secret and not any(c in user+secret for c in '\r\n\x00')
        text='[freepbx-calllive]\nsecret = '+secret+'\ndeny = 0.0.0.0/0.0.0.0\npermit = 127.0.0.1/255.255.255.255\nread = call,agent\nwrite = reporting\ndisplayconnects = no\neventfilter = Event: ('+events+')\n'
    else:
        text=path.read_text()
        assert re.search(r'^\[freepbx-calllive\]\s*$', text, re.M), 'Unexpected AMI section'
        # Refuse multi-account files rather than modifying another account.
        assert len(re.findall(r'^\[', text, re.M)) == 1, 'Expected dedicated CallLive AMI file'
        text=re.sub(r'^\s*read\s*=.*$', 'read = call,agent', text, flags=re.M)
        text=re.sub(r'^\s*eventfilter\s*=.*$', '', text, flags=re.M)
        text+='\neventfilter = Event: ('+events+')\n'
    path.write_text(text)
    os.chmod(str(path), 0o640)
    include=pathlib.Path('/etc/asterisk/manager_custom.conf')
    current=include.read_text() if include.exists() else ''
    if not re.search(r'^\s*#include\s+"?manager_calllive\.conf"?\s*$', current, re.M):
        include.write_text(current+'\n#include manager_calllive.conf\n')
PY
if [ -f /etc/asterisk/manager_calllive.conf ]; then chown root:asterisk /etc/asterisk/manager_calllive.conf; fi
asterisk -rx 'manager reload' >/dev/null
"$cl_python" "$cl_source/deploy/collector.py" --check

install -d -m 0755 -o root -g root /opt/freepbx-calllive
install -d -m 0750 -o "$cl_run_user" -g "$cl_run_group" /var/lib/freepbx-calllive
for cl_name in collector.py telemetry.py release.json; do
    install -m 0644 -o root -g root "$cl_source/deploy/$cl_name" "/opt/freepbx-calllive/.$cl_name.new"
    mv -f -- "/opt/freepbx-calllive/.$cl_name.new" "/opt/freepbx-calllive/$cl_name"
done
# Preserve all administrator drop-ins (including Python 3.6 and custom groups).
sed -e "s|^ExecStart=.*|ExecStart=$cl_python /opt/freepbx-calllive/collector.py|" -e "s|^User=.*|User=$cl_run_user|" -e "s|^Group=.*|Group=$cl_run_group|" "$cl_source/deploy/freepbx-calllive.service" > /etc/systemd/system/freepbx-calllive.service
chmod 0644 /etc/systemd/system/freepbx-calllive.service
systemctl daemon-reload
cl_started="$(date +%s)"
if [ "$cl_was_active" = 1 ]; then systemctl restart freepbx-calllive.service;
else systemctl enable freepbx-calllive.service; systemctl start freepbx-calllive.service; fi
cl_ready=0
for cl_attempt in {1..20}; do
    if "$cl_python" - "$cl_collector_version" "$cl_started" <<'PY'
import json, sys
try:
    with open('/run/freepbx-calllive/snapshot.json') as f: data=json.load(f)
    assert data['state']=='ready' and data['collector_version']==sys.argv[1]
    assert data['updated_at']>=int(sys.argv[2])
    assert data['journal']['enabled'] and not data['journal']['storage_error']
except (OSError, ValueError, KeyError, AssertionError):
    sys.exit(1)
PY
    then cl_ready=1; break; fi
    sleep 1
done
[ "$cl_ready" = 1 ] || { false; }
trap - EXIT
say "Сборщик CallLive $cl_collector_version работает. AMI и запись истории проверены."
say "Резервная копия: $cl_backup"
printf 'Команда отката: bash %q --rollback %q\n' "$cl_source/deploy/update-root.sh" "$cl_backup"
say 'Теперь примените локальную подпись из релиза и обновите страницу монитора.'
