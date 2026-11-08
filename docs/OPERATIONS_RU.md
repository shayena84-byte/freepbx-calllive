# Установка и эксплуатация CallLive 15.0.7

Модуль FreePBX и сборщик устанавливаются отдельно. Модуль даёт страницу **Отчёты → Монитор телефонии**. Служба `freepbx-calllive.service` получает данные Asterisk и пишет снимок, который читает страница. При уже установленном сборщике начните с раздела [Обновление](#обновление).

## Проверка перед установкой

Работайте в консоли сервера FreePBX под `root`. Примеры рассчитаны на типовые пути FreePBX 15 и системную группу `asterisk`.

```bash
fwconsole --version
asterisk -rx 'core show version'
fwconsole setting AMPWEBROOT
fwconsole setting AMPASTERISKWEBUSER
fwconsole setting AMPASTERISKWEBGROUP
getent group asterisk
for CALLLIVE_PYTHON in /usr/bin/python3 /usr/bin/python3.6; do
    if [ -x "$CALLLIVE_PYTHON" ]; then "$CALLLIVE_PYTHON" --version; fi
done
asterisk -rx 'manager show settings'
grep -n 'manager_custom\.conf' /etc/asterisk/manager.conf
```

Нужен Python **3.6+**. Если в системе уже есть `/usr/bin/python3.6`, используйте этот интерпретатор в службе. Сборщик использует стандартную библиотеку Python. Для настройки AMI нужен `openssl`, для подписи — PHP CLI с POSIX и OpenSSL, а также `gpg` или `gpg2`.

В выводе Asterisk проверьте, что AMI включён и принимает соединения с `127.0.0.1`. Сборщик подключается к IPv4 loopback. По умолчанию используется порт 5038. Для другого порта укажите значение в примере настройки AMI. Если FreePBX использует иной веб-каталог, замените `/var/www/html` в путях ниже.

## Установка модуля через FreePBX

1. Скачайте [архив 15.0.7](../dist/15.0.7/freepbx15-calllive-15.0.7.tar.gz). Для проверки скачайте рядом [SHA256SUMS.txt](../dist/15.0.7/SHA256SUMS.txt) и оба файла подписи. В этом каталоге выполните `sha256sum -c SHA256SUMS.txt`.
2. В админке откройте **Администрирование → Module Admin → Upload Module**, выберите архив и загрузите его.
3. Вернитесь к **Local Module Administration**. Найдите **Монитор телефонии**, выберите установку, выполните **Process → Confirm** и дождитесь сообщения об успехе.
4. Нажмите **Apply Config**. Код сборщика появится в `/var/www/html/admin/modules/calllive/deploy/`. Дальнейшие команды используют файлы из этого каталога.

Справка по загрузке стороннего модуля доступна в документации Sangoma. [Download and Installing Custom Modules](https://sangomakb.atlassian.net/wiki/spaces/PG/pages/26477115/Download+and+Installing+Custom+Modules)

## Доступ пользователя

В **Администрирование → User Management → Users** выберите пользователя и откройте вкладку **Administration GUI**. Укажите значения из таблицы и сохраните настройки.

| Параметр | Значение |
| --- | --- |
| **Allow Administration Login** | **Yes** |
| **Grant Full Administration Rights** | **No** |
| **Administration Access / Admin Sections** | **Монитор телефонии** |

Пользователю нужно выйти из FreePBX и войти заново. Монитор откроется в **Отчёты → Монитор телефонии**. Если учётная запись настроена через **Администрирование → Administrators**, выдайте ей раздел **Монитор телефонии** в списке разрешённых разделов.

Право `calllive` разрешает просмотр всех вызовов, номеров и транков АТС вместе с техническими карточками, DND и переадресацией. В этом модуле оно даёт обзор всей АТС, включая номера за пределами **Visible Extension Range**. Панель читает состояние и сведения о конфигурации. Доступ к изменению настроек определяется разрешениями соответствующих разделов FreePBX. [User Management Group/User Settings](https://sangomakb.atlassian.net/wiki/spaces/PG/pages/20808182)

## Первая настройка сборщика

### Учётная запись AMI

Пример создаёт отдельного пользователя `freepbx-calllive` и генерирует секрет прямо на АТС. Пользователь допускается с `127.0.0.1` и получает события вызовов и доступ к классу запросов `reporting`. В типовой конфигурации `manager.conf` подключает `manager_custom.conf`. Если у вас другой локальный файл включений, исправьте `CALLLIVE_INCLUDE` перед выполнением.

```bash
(
    set -eu
    umask 077
    CALLLIVE_PORT=5038
    CALLLIVE_ENV=/etc/freepbx-calllive.env
    CALLLIVE_AMI=/etc/asterisk/manager_calllive.conf
    CALLLIVE_INCLUDE=/etc/asterisk/manager_custom.conf

    getent group asterisk >/dev/null
    if [ -e "$CALLLIVE_ENV" ] || [ -L "$CALLLIVE_ENV" ] ||
       [ -e "$CALLLIVE_AMI" ] || [ -L "$CALLLIVE_AMI" ]; then
        printf '%s\n' 'Конфигурация CallLive уже существует. Проверьте её перед продолжением.' >&2
        exit 1
    fi
    CALLLIVE_SECRET="$(openssl rand -hex 32)"

    printf 'CALLLIVE_AMI_USER=freepbx-calllive\nCALLLIVE_AMI_PORT=%s\nCALLLIVE_AMI_SECRET=%s\n' \
        "$CALLLIVE_PORT" "$CALLLIVE_SECRET" > "$CALLLIVE_ENV"
    {
        printf '[freepbx-calllive]\nsecret = %s\n' "$CALLLIVE_SECRET"
        cat <<'AMI'
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = call
write = reporting
displayconnects = no
eventfilter = Event: (Newchannel|Newstate|NewCallerid|NewConnectedLine|Hangup|DialBegin|DialEnd|BridgeCreate|BridgeDestroy|BridgeEnter|BridgeLeave|BridgeMerge|ExtensionStatus|Hold|Unhold|ParkedCall|UnParkedCall|ParkedCallTimeOut|ParkedCallGiveUp)
AMI
    } > "$CALLLIVE_AMI"
    chown root:asterisk "$CALLLIVE_AMI"
    chmod 0640 "$CALLLIVE_AMI"
    if [ ! -e "$CALLLIVE_INCLUDE" ] && [ ! -L "$CALLLIVE_INCLUDE" ]; then
        install -m 0640 -o root -g asterisk /dev/null "$CALLLIVE_INCLUDE"
    fi
    if ! grep -Fqx '#include manager_calllive.conf' "$CALLLIVE_INCLUDE"; then
        printf '\n#include manager_calllive.conf\n' >> "$CALLLIVE_INCLUDE"
    fi
    asterisk -rx 'manager reload'
)
```

Файл окружения создаётся с правами `0600`. Системный менеджер читает его при запуске службы. Asterisk читает `manager_calllive.conf` с правами `0640` через группу `asterisk`. Пароль остаётся в этих двух файлах на АТС. [Asterisk Manager TCP/IP API](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-Manager-Interface-AMI/The-Asterisk-Manager-TCP-IP-API/)

### Установка службы

```bash
(
    set -eu
    CALLLIVE_SOURCE=/var/www/html/admin/modules/calllive
    test -r "$CALLLIVE_SOURCE/deploy/collector.py"
    test -r "$CALLLIVE_SOURCE/deploy/freepbx-calllive.service"
    test -r /etc/freepbx-calllive.env
    if systemctl cat freepbx-calllive.service >/dev/null 2>&1; then
        printf '%s\n' 'Служба уже установлена. Используйте раздел обновления.' >&2
        exit 1
    fi
    id -u freepbx-calllive >/dev/null 2>&1 || \
        useradd --system --no-create-home --gid asterisk --shell /sbin/nologin freepbx-calllive
    install -d -m 0755 -o root -g root /opt/freepbx-calllive
    install -d -m 0750 -o freepbx-calllive -g asterisk /var/lib/freepbx-calllive
    install -m 0644 -o root -g root \
        "$CALLLIVE_SOURCE/deploy/collector.py" /opt/freepbx-calllive/collector.py
    install -m 0644 -o root -g root \
        "$CALLLIVE_SOURCE/deploy/freepbx-calllive.service" /etc/systemd/system/freepbx-calllive.service
    systemctl daemon-reload
)
```

Unit по умолчанию запускает `/usr/bin/python3`. Если рабочий интерпретатор находится по пути `/usr/bin/python3.6`, выполните `systemctl edit freepbx-calllive.service` и добавьте настройки ниже. Пустой `ExecStart=` очищает команду основного unit перед заданием новой. Если веб-процесс FreePBX использует другую группу, добавьте соответствующий `Group=` в эту же секцию.

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/python3.6 /opt/freepbx-calllive/collector.py
```

На системах с обычным `/usr/bin/python3` достаточно основного unit. Запустите службу и проверьте её состояние.

```bash
systemctl daemon-reload
systemctl enable --now freepbx-calllive.service
systemctl status freepbx-calllive.service --no-pager -l
stat -c '%y %a %U:%G %n' /run/freepbx-calllive/snapshot.json
```

Служба создаёт каталог `/run/freepbx-calllive` при запуске. Снимок обновляется примерно раз в 5 секунд в простое и чаще при событиях вызовов. Суточная статистика сохраняется в `/var/lib/freepbx-calllive/daily.json`.

## Обновление

### Модуль

Загрузите новый установочный архив через **Module Admin → Upload Module**, выполните обновление **Монитор телефонии**, затем нажмите **Apply Config**. Для локальной подписи запустите скрипт новой версии после установки. При переходе с 15.0.4, 15.0.5 или 15.0.6 достаточно обновить модуль и подпись. Код сборщика совпадает в 15.0.4, 15.0.5, 15.0.6 и 15.0.7.

### Сборщик

Обновите сборщик при переходе с **15.0.3 или более ранней версии** или когда в следующей версии изменится `deploy/collector.py`. Сравнить установленный файл с тем, который входит в модуль, можно под root.

```bash
sha256sum /opt/freepbx-calllive/collector.py /var/www/html/admin/modules/calllive/deploy/collector.py
systemctl show -p ExecStart -p User -p Group freepbx-calllive.service
```

Для сборщика 15.0.4–15.0.7 ожидаемая сумма SHA-256 — `845f8bb05e21fc4f5f5456c29ee0e25d5654c19f66a097c3b0b7bc2e66cc9765`. Совпавшие суммы означают, что нужный код уже установлен.

Если суммы различаются, сначала установите модуль через GUI. В примере ниже проверьте веб-каталог, интерпретатор из `ExecStart` и пользователя службы. Команда проверяет синтаксис новой копии, сохраняет прежний файл и заменяет его одним переименованием. Перезапускается только сборщик.

```bash
(
    set -eu
    CALLLIVE_SOURCE=/var/www/html/admin/modules/calllive/deploy/collector.py
    CALLLIVE_TARGET=/opt/freepbx-calllive/collector.py
    CALLLIVE_PYTHON=/usr/bin/python3.6
    test -s "$CALLLIVE_SOURCE"
    test -f "$CALLLIVE_TARGET"
    if cmp -s "$CALLLIVE_SOURCE" "$CALLLIVE_TARGET"; then
        printf '%s\n' 'Код сборщика уже совпадает с установленным модулем.'
        exit 0
    fi
    "$CALLLIVE_PYTHON" -c 'import sys; path = sys.argv[1]; compile(open(path, "rb").read(), path, "exec")' \
        "$CALLLIVE_SOURCE"
    install -d -m 0750 -o freepbx-calllive -g asterisk /var/lib/freepbx-calllive
    CALLLIVE_NEXT="$(mktemp /opt/freepbx-calllive/.collector.XXXXXX)"
    trap 'rm -f -- "$CALLLIVE_NEXT"' EXIT
    install -m 0644 -o root -g root "$CALLLIVE_SOURCE" "$CALLLIVE_NEXT"
    CALLLIVE_BACKUP="$(mktemp /opt/freepbx-calllive/collector.py.previous.XXXXXX)"
    cp -p -- "$CALLLIVE_TARGET" "$CALLLIVE_BACKUP"
    printf 'Резервная копия сборщика находится в %s\n' "$CALLLIVE_BACKUP"
    mv -f -- "$CALLLIVE_NEXT" "$CALLLIVE_TARGET"
    systemctl restart freepbx-calllive.service
    systemctl is-active freepbx-calllive.service
)
```

После запуска проверьте журнал и страницу монитора. Если новая копия не запускается, возьмите путь к резервной копии из вывода команды, восстановите её как `/opt/freepbx-calllive/collector.py` и перезапустите `freepbx-calllive.service`. Каталог со статистикой и параметры AMI хранятся отдельно от файла сборщика.

## Локальная подпись

### Подпись CallLive 15.0.7

Подписывайте **после установки или обновления** модуля и **Apply Config**. Скрипт этой версии сначала сверяет SHA-256 всех файлов установленного CallLive с архивом 15.0.7. Для каждой следующей версии нужен соответствующий скрипт подписи.

| Как вы работаете с АТС | Действие |
| --- | --- |
| Доступна консоль root | Откройте [root-команду](../dist/15.0.7/calllive-15.0.7-sign-root-command.txt) на компьютере. Вставьте весь текст от первой строки `php -f /dev/stdin` до строки `CALLLIVE_SIGN_1507` включительно в консоль АТС и нажмите Enter |
| PHP-скрипт уже лежит на сервере | Запустите [скрипт подписи](../dist/15.0.7/calllive-15.0.7-sign-local.php) в PHP CLI под root. Для файла в `/root` используйте команду ниже |

```bash
php /root/calllive-15.0.7-sign-local.php
```

Результат успешной проверки — `Локальная подпись CallLive действительна.` Затем обновите страницу **Module Admin**.

При первом запуске скрипт создаёт ключ CallLive в `/etc/freepbx.secure/calllive-key`. При повторном запуске используется ключ этой АТС. В GPG-хранилище пользователя FreePBX импортируется открытая часть ключа. Закрытый ключ хранится на АТС в каталоге root с режимом `0700`. Внутренняя подпись записывается в `/etc/freepbx.secure/calllive.sig`, а `module.sig` — в каталог установленного CallLive. Скрипт проверяет итоговый статус через FreePBX.

Предупреждение GPG о правах на `/home/asterisk/.gnupg` относится к каталогу ключей FreePBX. Ориентируйтесь на итоговое сообщение скрипта и статус модуля. Текущего владельца и режим каталога можно проверить командой `stat -c '%a %U:%G %n' /home/asterisk/.gnupg`.

### Подпись других собственных модулей

Локальная подпись применяется на конкретной АТС. Для собственных модулей подготовьте GPG-ключ и установите инструменты FreePBX `devtools` по руководству Sangoma. Импортируйте открытый ключ в хранилище FreePBX по инструкции для вашей версии. Затем выполните `sign.php` с путём к своему установленному модулю, параметром `--local` и идентификатором ключа. [Signing your own modules](https://sangomakb.atlassian.net/wiki/spaces/FP/pages/10420868/Signing+your+own+modules)

```bash
cd /usr/src/devtools
./sign.php /var/www/html/admin/modules/my-module --local "$FREEPBX_LOCAL_KEY_ID"
```

Замените `my-module` на имя своего модуля. В `FREEPBX_LOCAL_KEY_ID` перед запуском укажите ID подготовленного ключа. Для CallLive используйте его версионный скрипт из предыдущего раздела.

## Проверка работы и диагностика

1. Откройте **Отчёты → Монитор телефонии** под пользователем с разрешением на раздел «Монитор телефонии». Прямой путь — `/admin/config.php?display=calllive`.
2. Сделайте внутренний тестовый звонок и дождитесь соединения. Проверьте участников, длительность и карточку разговора. Для проверки транка сделайте тестовый вызов по маршруту, который его использует.
3. Дождитесь доступных замеров RTP/RTCP. Сравните процент в строке и карточке. При дозвоне и до получения достаточных замеров отображается прочерк. Завершите звонок с открытой карточкой и проверьте последний снимок.
4. Откройте карточки внутреннего номера и транка. Проверьте доступные сведения о DND, переадресации и статусе SIP.

| Признак | Что проверить |
| --- | --- |
| `Unit freepbx-calllive.service could not be found` | Установите unit и выполните `systemctl daemon-reload` |
| `No such file or directory` для `/usr/bin/python3` | Найдите рабочий Python 3.6+ и задайте его через `systemctl edit` |
| `AMI недоступен` или `Ошибка входа в AMI` | Состояние AMI, порт, включение `manager_calllive.conf`, имя и совпадение секрета в двух локальных файлах |
| `AMI отклонил запрос` | Название действия в журнале и класс `write = reporting` для пользователя сборщика |
| `Нет данных от сборщика` | Службу, свежесть снимка и возможность чтения файла веб-пользователем FreePBX |
| `Суточные счётчики пока сохраняются только в памяти` | Путь `/var/lib/freepbx-calllive` и право записи пользователя сборщика |
| При подписи файл отсутствует или отличается | Версию в **Module Admin** и установочный архив. Запускайте соответствующий версии скрипт после установки |

```bash
systemctl status freepbx-calllive.service --no-pager -l
journalctl -u freepbx-calllive.service -b -n 50 --no-pager
stat -c '%y %a %U:%G %n' /run/freepbx-calllive/snapshot.json /var/lib/freepbx-calllive/daily.json
runuser -u asterisk -- test -r /run/freepbx-calllive/snapshot.json && echo 'Снимок читается'
```

Для разовой проверки AMI выполните `--check` под root. Укажите Python из `ExecStart`. Команда выводит только количество каналов и hints.

```bash
(
    set -eu
    set -a
    . /etc/freepbx-calllive.env
    set +a
    /usr/bin/python3.6 /opt/freepbx-calllive/collector.py --check
)
```
