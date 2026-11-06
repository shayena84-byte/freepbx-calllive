# Монитор телефонии для FreePBX 15

**CallLive 15.0.6** добавляет страницу **Отчёты → Монитор телефонии** в админку FreePBX. Сборщик получает события из локального AMI Asterisk. При изменениях он переснимает состояние, ограничивая частоту запросов к АТС. В простое проверяет состояние каждые 5 секунд. Открытая панель читает снимок примерно раз в секунду.

## Что отображается

| Раздел | Данные |
| --- | --- |
| За сутки | Максимум одновременных разговоров и длительность самого длинного разговора по календарному дню АТС |
| Текущие вызовы | Участники, внутренние номера и имена, внешний номер при наличии достоверных данных, транк, состояние, оценка качества от 0 до 100% и время с создания старейшего активного канала вызова |
| Детали разговора | По клику на активное соединение открывается карточка с каналами, кодеками, идентификаторами, медиамостами и показателями RTP/RTCP |
| Транки | Транки из настроек FreePBX и число сопоставленных активных каналов. Это показатель использования |
| Внутренние номера | Разговор, удержание, дозвон, снятая трубка при сигнале OffHook, занятость, недоступность и свободная линия. Можно искать по номеру или имени |

### Суточные счётчики

Сутки идут с 00:00 до следующего 00:00 в часовом поясе сервера АТС. Сборщик считает соединённые разговоры по медиамостам Asterisk. Удержание и конференция учитываются как одно соединение. Длительность отсчитывается с момента соединения и ограничивается временем внутри текущих суток. У разговора, переходящего через полночь, начинается новый суточный отсчёт. Сбор начинается с запуска версии 15.0.4 и работает при закрытой панели. Значения записываются в `/var/lib/freepbx-calllive/daily.json` и восстанавливаются при перезапуске службы.

Для подтверждённого соединения используются медиамосты Asterisk и каналы в состоянии Up. Связанные каналы без подтверждённого медиамоста показываются отдельной строкой. Два отдельных моста при переводе видны как отдельные соединения, а абонент в очереди отображается в ожидании или дозвоне.

Названия сопоставляются для стандартных **PJSIP**, **chan_sip**, **IAX2** и отдельных числовых каналов **DAHDI**. Нестандартный SIP-пир может иметь имя канала, отличающееся от записи FreePBX. При таком расхождении, при совпадающих именах пиров и при нестандартных транках (например, Custom и группы DAHDI) панель показывает активный канал с его именем, если он доступен через AMI. Привязка к транку в этих случаях требует дополнительного правила.

Состояния внутренних номеров основаны на каналах и hints в стандартном контексте `ext-local`. Статус «Снята трубка» требует, чтобы Asterisk сообщал состояние OffHook по каналу, сопоставленному с номером. IP-телефон может давать локальный гудок и передать первый SIP-запрос только после набора. До этого момента АТС может видеть линию свободной. При перезапуске сборщик восстанавливает текущие каналы, мосты и hints. Признаки направления и удержания отдельного канала, известные только из событий, снова появятся по мере поступления этих событий.

### Качество аудиоканалов

В столбце **Качество** и в карточке разговора показана оценка от 0 до 100% по худшему из измеренных каналов. Для расчёта по каналу нужна доля потерь хотя бы в одном направлении и замер джиттера или RTT. Для доли потерь требуется не менее 20 RTP-пакетов в направлении. При дозвоне и при недостатке данных отображается прочерк. Пометка **частично** означает, что некоторые каналы или показатели недоступны.

Оценка канала равна 100, умноженным на коэффициенты доступных показателей. Между границами из таблицы коэффициент линейно падает с 1 до 0. Для потерь берётся худшая из доступных долей за время жизни канала.

| Показатель | Коэффициент 1 | Коэффициент 0 |
| --- | --- | --- |
| Доля потерь RTP | До 0,1% | От 10% |
| Джиттер на приёме в АТС | До 20 мс | От 100 мс |
| RTT по RTCP | До 150 мс | От 800 мс |

Нажмите на строку соединённого вызова или на кнопку **Подробнее**. Карточка обновляется во время разговора. Для каждого SIP или PJSIP-канала видны счётчики принятых и отправленных RTP-пакетов, джиттер при приёме в АТС, потери в пакетах по доступным отчётам и RTT по RTCP. RTT показывает время прохождения сигнала туда и обратно на участке между АТС и удалённой стороной канала.

После отбоя карточка остаётся открытой. В ней сохраняются участники, параметры каналов, оценка качества и последние полученные показатели RTP/RTCP со временем снимка. Карточку можно изучать до её закрытия.

Сборщик запрашивает параметры через AMI `Status` и `Getvar` примерно раз в 5 секунд. При большой нагрузке SIP-каналы опрашиваются по очереди. «—» означает, что значение пока недоступно. При прямой передаче медиа между устройствами АТС может не видеть RTP. Сведения из RTCP появляются после обмена отчётами. В Asterisk 16 нулевой счётчик локальных потерь также служит начальным значением, поэтому карточка показывает локальные потери, когда АТС зафиксировала пропуски.

### Карточки внутренних номеров и транков

Нажмите на строку или кнопку с номером либо именем транка. В карточке номера доступны DND в АТС, переадресация всех вызовов, при занятости и при неответе или недоступности, ожидание второго вызова, Follow Me, настройки номера и связанные устройства. У транка видны текущие каналы, лимит, Caller ID, маршруты и, где АТС их предоставляет, параметры SIP и состояние регистрации. Дополнительные сведения обновляются, пока карточка открыта. Режим DND, установленный только на телефоне, зависит от того, передал ли телефон его на АТС.

## Обновление установленного CallLive

Загрузите `freepbx15-calllive-15.0.6.tar.gz` в **Администрирование → Module Admin → Upload Module**, установите обновление **Монитор телефонии** и нажмите **Apply Config**. При обновлении с 15.0.4 или 15.0.5 этих шагов достаточно для работы новой версии.

При обновлении с версии 15.0.3 или более ранней перенесите тот же архив в `/tmp` на сервер FreePBX. Создайте каталог суточной статистики, обновите файл сборщика и перезапустите службу CallLive под root. Команды рассчитаны на пользователя службы `freepbx-calllive` и группу `asterisk`.

```bash
(
    set -eu
    install -d -m 0750 -o freepbx-calllive -g asterisk /var/lib/freepbx-calllive
    CALLLIVE_NEXT="$(mktemp /opt/freepbx-calllive/.collector.XXXXXX)"
    trap 'rm -f -- "$CALLLIVE_NEXT"' EXIT
    tar -xOzf /tmp/freepbx15-calllive-15.0.6.tar.gz calllive/deploy/collector.py > "$CALLLIVE_NEXT"
    test -s "$CALLLIVE_NEXT"
    chmod 0644 "$CALLLIVE_NEXT"
    mv -f -- "$CALLLIVE_NEXT" /opt/freepbx-calllive/collector.py
    systemctl restart freepbx-calllive.service
    systemctl is-active freepbx-calllive.service
)
```

Служба использует путь к Python из действующего `ExecStart`, в том числе `/usr/bin/python3.6`. Для сбора показателей подходят существующие права AMI `read = call` и `write = reporting`.

Если вы применяли локальную подпись, после обновления подпишите установленный модуль скриптом `calllive-15.0.6-sign-local.php` под root. Скрипт проверяет файлы именно версии 15.0.6 и использует локальный ключ CallLive.

## Требования

- FreePBX 15 с модулем Core. Целевая конфигурация использует Asterisk 16 или совместимую версию с AMI-действиями `CoreShowChannels`, `BridgeList` и `ExtensionStateList`.
- Linux с systemd, Python 3.6 или новее и OpenSSL для генерации секрета. Сборщик использует стандартную библиотеку Python.
- AMI на `127.0.0.1`, обычно TCP 5038. Сборщик запускается на той же машине, что и Asterisk.
- Для просмотра требуется администратор FreePBX со всеми разделами и без ограничения по диапазону внутренних номеров. Права проверяются для страницы и каждого запроса панели.

## Установка

Перенесите архив `freepbx15-calllive-15.0.6.tar.gz` на сервер, например в `/tmp`. Команды ниже предназначены для root и предполагают стандартные пути и группу `asterisk`. Перед выполнением посмотрите версию и пути.

```bash
fwconsole --version
asterisk -rx 'core show version'
fwconsole setting AMPWEBROOT
/usr/bin/python3 --version || /usr/bin/python3.6 --version
getent group asterisk
asterisk -rx 'manager show settings'
grep -n 'manager_custom\.conf' /etc/asterisk/manager.conf
```

В выводе AMI должны быть включённый интерфейс и адрес, доступный через `127.0.0.1`. Укажите фактический порт ниже. В `manager.conf` должен подключаться `manager_custom.conf` или отдельный локальный файл, указанный администратором. Для нестандартного пути замените его в соответствующих командах.

### 1. Зарегистрируйте модуль FreePBX

В админке откройте **Администрирование → Module Admin → Upload Module**, загрузите архив и установите **Монитор телефонии** через **Local Module Administration**. Нажмите **Apply Config** для подключения ресурсов страницы. Для дальнейших команд укажите путь к установленному модулю в переменной `CALLLIVE_SOURCE`. При стандартном веб-каталоге это `/var/www/html/admin/modules/calllive`.

Для установки через консоль выполните команды ниже.

```bash
CALLLIVE_ARCHIVE=/tmp/freepbx15-calllive-15.0.6.tar.gz
CALLLIVE_WEBROOT=/var/www/html
CALLLIVE_WORK="$(mktemp -d)"
tar --no-same-owner -xzf "$CALLLIVE_ARCHIVE" -C "$CALLLIVE_WORK"
CALLLIVE_SOURCE="$CALLLIVE_WORK/calllive"
CALLLIVE_MODULE="$CALLLIVE_WEBROOT/admin/modules/calllive"

install -d -o asterisk -g asterisk "$CALLLIVE_MODULE"
cp -R "$CALLLIVE_SOURCE"/{module.xml,Calllive.class.php,page.calllive.php,assets,deploy,README_RU.md,LICENSE} "$CALLLIVE_MODULE/"
chown -R asterisk:asterisk "$CALLLIVE_MODULE"
fwconsole ma install calllive
fwconsole reload
```

FreePBX может показать уведомление об отсутствии подписи Sangoma у локального модуля.

### 2. Создайте отдельного пользователя AMI

Выполните один раз. Команды создают отдельные файлы и добавляют одну директиву в `manager_custom.conf`.

```bash
(
    set -eu
    CALLLIVE_PORT=5038
    CALLLIVE_ENV=/etc/freepbx-calllive.env
    CALLLIVE_AMI=/etc/asterisk/manager_calllive.conf
    CALLLIVE_INCLUDE=/etc/asterisk/manager_custom.conf

    if [ -e "$CALLLIVE_ENV" ] || [ -e "$CALLLIVE_AMI" ]; then
        echo "Файлы CallLive уже существуют. Проверьте действующую конфигурацию." >&2
        exit 1
    fi

    umask 077
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

    if ! grep -Fqx '#include manager_calllive.conf' "$CALLLIVE_INCLUDE" 2>/dev/null; then
        printf '\n#include manager_calllive.conf\n' >> "$CALLLIVE_INCLUDE"
    fi
)
asterisk -rx 'manager reload'
```

AMI использует параметр `write` для допуска к действиям. Класс `reporting` нужен для запросов списков. Сборщик отправляет только вход и запросы состояния. Секрет хранится локально в AMI-конфигурации и в файле окружения службы. Снимок с номерами доступен группе процесса FreePBX в `/run`.

### 3. Запустите сборщик

В той же root-сессии, где задан `CALLLIVE_SOURCE`, выполните команды.

```bash
id -u freepbx-calllive >/dev/null 2>&1 || \
    useradd --system --no-create-home --gid asterisk --shell /sbin/nologin freepbx-calllive

install -d -m 0755 -o root -g root /opt/freepbx-calllive
install -d -m 0750 -o freepbx-calllive -g asterisk /var/lib/freepbx-calllive
install -m 0644 -o root -g root "$CALLLIVE_SOURCE/deploy/collector.py" /opt/freepbx-calllive/collector.py
install -m 0644 -o root -g root "$CALLLIVE_SOURCE/deploy/freepbx-calllive.service" \
    /etc/systemd/system/freepbx-calllive.service

systemctl daemon-reload
```

Если Python установлен по пути `/usr/bin/python3.6`, выполните `systemctl edit freepbx-calllive.service` и задайте путь в секции службы.

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/python3.6 /opt/freepbx-calllive/collector.py
```

Запустите службу.

```bash
systemctl enable --now freepbx-calllive.service
systemctl status freepbx-calllive.service --no-pager
```

На установках, где веб-процесс FreePBX использует другую группу, задайте её в свойстве `Group=` службы CallLive через `systemctl edit freepbx-calllive.service`, затем перезапустите службу. Именно эта группа получает доступ к `/run/freepbx-calllive/snapshot.json`.

### 4. Проверьте панель

Откройте **Отчёты → Монитор телефонии**. Если меню локализовано частично, раздел называется **Reports**. Прямой путь относительно FreePBX выглядит как `/admin/config.php?display=calllive`.

1. Позвоните с одного внутреннего номера на другой. При дозвоне появится вызов, после ответа — соединение с обоими номерами. Завершите звонок и проверьте исчезновение строки.
2. Сделайте исходящий и входящий вызов через известный транк. У транка появится активный канал, а имя транка будет в строке вызова.
3. Сравните список состояний с `asterisk -rx 'core show hints'`. Если телефон сигнализирует OffHook, проверьте также отображение этого состояния.
4. При проверке удержания дождитесь обновления панели после Hold и Unhold. Состояние доступно в той мере, в какой его передаёт Asterisk.
5. Откройте **Подробнее** во время SIP-разговора. Сверьте имена каналов и форматы звука. При прохождении RTP через АТС счётчики пакетов должны меняться между снимками. После получения замеров оценка качества в строке и в карточке совпадает.
6. Завершите разговор при открытой карточке. Сверьте время последнего снимка и сохранённые в карточке данные, включая оценку качества.
7. Откройте карточки номера и транка, сравните услуги номера и настройки транка с FreePBX.

### Диагностика

```bash
journalctl -u freepbx-calllive.service -n 50 --no-pager
stat -c '%a %U:%G %n' /run/freepbx-calllive/snapshot.json
(
    set -a
    . /etc/freepbx-calllive.env
    set +a
    CALLLIVE_PYTHON="$(command -v python3 || command -v python3.6)"
    "$CALLLIVE_PYTHON" /opt/freepbx-calllive/collector.py --check
)
```

Проверка `--check` выводит только количество каналов и hints. При обрыве AMI сборщик помечает данные как недоступные и переподключается. В памяти сервера хранится последний снимок. Панель отклоняет снимок старше 18 секунд.

Если появилось «AMI отклонил запрос», посмотрите название действия в журнале. Для несопоставленного канала сравните имя канала с endpoint или peer в настройках FreePBX. Статус «Нет сигнала» у внутреннего номера означает, что панель не нашла соответствующий hint или активный канал.

### Удаление

Остановите службу, затем удалите модуль из **Администрирование → Управление модулями** или через `fwconsole ma uninstall calllive`. Удалите строку `#include manager_calllive.conf` из файла, куда она была добавлена. После этого удалите файлы `/etc/asterisk/manager_calllive.conf`, `/etc/freepbx-calllive.env`, `/etc/systemd/system/freepbx-calllive.service` и `/opt/freepbx-calllive/collector.py`. Выполните `systemctl daemon-reload`, `asterisk -rx 'manager reload'` и `fwconsole reload`.

```bash
systemctl disable --now freepbx-calllive.service
fwconsole ma uninstall calllive
```

## Документация

- [Спецификация Asterisk AMI v2 и события мостов](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-Manager-Interface-AMI/AMI-v2-Specification/)
- [Настройка учётных записей и классов доступа AMI](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-Manager-Interface-AMI/The-Asterisk-Manager-TCP-IP-API/)
- [Параметры канала и статистика RTCP в Asterisk](https://docs.asterisk.org/Latest_API/API_Documentation/Dialplan_Functions/CHANNEL/)
- [Вызовы AJAX в модулях FreePBX](https://sangomakb.atlassian.net/wiki/spaces/FP/pages/10420542)
- [Подписи модулей FreePBX](https://sangomakb.atlassian.net/wiki/spaces/PG/pages/26477136)
