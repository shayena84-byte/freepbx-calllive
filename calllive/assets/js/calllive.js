(() => {
    'use strict';

    const root = document.getElementById('calllive');
    if (!root) return;

    const byId = (id) => document.getElementById(id);
    const unknown = '—';
    const connectedPhases = new Set(['connected', 'held', 'conference']);
    const detailDialog = byId('cl-detail');
    const entityDialog = byId('cl-entity');
    const detailNumber = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
    const callButtons = new Map();
    const entityButtons = new Map();
    const phases = {
        connected: ['Соединены', 'ok'],
        held: ['Удержание', 'wait'],
        conference: ['Групповое соединение', 'ok'],
        ringing: ['Дозвон', 'wait'],
        queue: ['В очереди', 'wait'],
        parked: ['Припаркован', 'wait'],
        waiting: ['Ожидание', 'wait'],
        service: ['Сервис АТС', 'neutral'],
        setup: ['Есть канал', 'neutral'],
    };

    const health = {
        ready: ['Связь с АТС есть', 'ok', ''],
        ami_offline: ['AMI недоступен', 'danger', 'Проверьте доступность AMI на локальном порту Asterisk и журнал службы freepbx-calllive.'],
        ami_auth: ['Ошибка входа в AMI', 'danger', 'Проверьте имя, секрет и ACL отдельной учётной записи AMI.'],
        ami_action: ['AMI отклонил запрос', 'danger', 'Проверьте доступность действий CoreShowChannels, BridgeList и ExtensionStateList и журнал службы.'],
        snapshot_limit: ['Слишком много данных', 'danger', 'Размер снимка превысил предел панели. Подробности есть в журнале службы.'],
        collector_unavailable: ['Нет данных от сборщика', 'danger', 'Проверьте службу freepbx-calllive и доступ FreePBX к её файлу состояния.'],
        request_error: ['Связь с FreePBX потеряна', 'danger', 'Панель повторит запрос автоматически.'],
        access_denied: ['Доступ завершён', 'danger', 'Войдите в FreePBX с полными правами администратора и обновите страницу.'],
    };

    let inventory = null;
    let inventoryChecked = 0;
    let inventoryError = false;
    let snapshot = null;
    let receivedAt = 0;
    let extensions = [];
    let selectedCall = '';
    let detailSignature = '';
    let lastCall = null;
    let selectedEntity = null;
    let entityTimer = null;
    let entityRequest = null;

    function node(tag, value = '', className = '') {
        const element = document.createElement(tag);
        element.textContent = value;
        if (className) element.className = className;
        return element;
    }

    function badge(text, tone) {
        const element = node('span', text, 'cl-badge');
        element.dataset.tone = tone;
        return element;
    }

    function cell(row, value, className = '') {
        const element = node('td', typeof value === 'string' ? value : '', className);
        if (typeof value !== 'string') element.appendChild(value);
        row.appendChild(element);
    }

    function table(id, rows, width, emptyText) {
        const body = byId(id);
        const content = document.createDocumentFragment();
        if (rows.length) {
            rows.forEach((row) => content.appendChild(row));
        } else {
            const row = node('tr');
            const message = node('td', emptyText, 'cl-empty');
            message.colSpan = width;
            row.appendChild(message);
            content.appendChild(row);
        }
        body.textContent = '';
        body.appendChild(content);
    }

    function techName(tech) {
        const value = String(tech).toUpperCase();
        if (value === 'ZAP') return 'DAHDI';
        return value === 'IAX' ? 'IAX2' : value;
    }

    function dialKey(dial) {
        const match = String(dial).match(/^(PJSIP|SIP|IAX2|DAHDI|ZAP)\/([^/@\s,;&]+)(?:\/.*)?$/i);
        if (!match) return '';
        const tech = techName(match[1]);
        if (tech === 'DAHDI' && !/^\d+$/.test(match[2])) return '';
        return tech + '/' + match[2];
    }

    function channelKey(name) {
        const match = name.match(/^([^/]+)\/([^/]+)-[0-9a-f]+$/i);
        return match ? dialKey(match[1] + '/' + match[2]) : '';
    }

    function index(map, key, value) {
        if (!key) return;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(value);
    }

    function buildLookups(data, hints) {
        const numbers = new Map(data.extensions.map((item) => [String(item.extension), item]));
        const states = new Map();
        const hintDevices = new Map();
        const fixedDevices = new Map();
        const trunks = new Map();
        for (const hint of hints) {
            if (!numbers.has(hint.ext)) continue;
            states.set(hint.ext, hint.status);
            for (const dial of hint.hint.split(',', 1)[0].split('&')) {
                index(hintDevices, dialKey(dial.trim()), hint.ext);
            }
        }
        for (const device of data.devices) {
            if (!numbers.has(String(device.user)) || device.devicetype === 'adhoc') continue;
            const tech = techName(device.tech);
            const key = dialKey(device.dial) || (tech === 'DAHDI' ? '' : dialKey(tech + '/' + device.id));
            index(fixedDevices, key, String(device.user));
        }
        for (const trunk of data.trunks) index(trunks, dialKey(techName(trunk.tech) + '/' + trunk.channelid), trunk);
        return {numbers, states, hintDevices, fixedDevices, trunks};
    }

    function assign(channel, lookup) {
        const key = channelKey(channel.name);
        const phones = lookup.hintDevices.get(key) || lookup.fixedDevices.get(key) || new Set();
        const providers = lookup.trunks.get(key) || new Set();
        if (phones.size === 1 && !providers.size) {
            return {channel, extension: lookup.numbers.get(phones.values().next().value)};
        }
        if (providers.size === 1 && !phones.size) {
            return {channel, trunk: providers.values().next().value, key};
        }
        return {channel, ambiguous: phones.size + providers.size > 1};
    }

    function formatNumber(value) {
        return value && !/^<?(?:unknown|none|unspecified|null)>?$/i.test(value) ? value : '';
    }

    function participant(item) {
        const {channel, extension, trunk} = item;
        const element = node('span', '', 'cl-participant');
        element.title = channel.name;
        let label;
        let detail;

        if (extension) {
            label = String(extension.extension);
            detail = extension.name || '';
        } else if (trunk) {
            const caller = formatNumber(channel.caller);
            const connected = formatNumber(channel.connected);
            const endpoint = item.key.split('/')[1];
            const dialed = channel.dialed === endpoint ? '' : channel.dialed;
            if (channel.direction === 'in') {
                label = caller || 'Входящий канал';
                detail = [formatNumber(channel.caller_name), 'Входящий'].filter((value) => value && value !== label).join(' · ');
            } else if (channel.direction === 'out') {
                label = dialed || (connected !== caller ? connected : '') || 'Исходящий канал';
                detail = 'Исходящий';
            } else {
                label = 'Внешний канал';
                detail = [caller && 'Caller ID ' + caller, connected && connected !== caller && 'Connected Line ' + connected]
                    .filter(Boolean).join(' · ');
            }
        } else {
            label = formatNumber(channel.caller) || formatNumber(channel.caller_name) || channel.name;
            detail = item.ambiguous ? 'Несколько соответствий · ' + channel.name : channel.name;
        }
        element.appendChild(node('strong', label));
        if (detail && detail !== label) element.appendChild(node('small', detail));
        return element;
    }

    function trunkName(trunk) {
        return trunk.name || techName(trunk.tech) + '/' + trunk.channelid;
    }

    function formatDuration(seconds) {
        if (!Number.isFinite(seconds)) return unknown;
        const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
        return parts.map((part) => String(part).padStart(2, '0')).join(':');
    }

    function duration(seconds) {
        return Number.isFinite(seconds) ? formatDuration(seconds + Math.floor((performance.now() - receivedAt) / 1000)) : unknown;
    }

    function timeLabel(timestamp) {
        return new Date(timestamp * 1000).toLocaleTimeString('ru-RU');
    }

    function callKey(group) {
        return JSON.stringify(group.channels);
    }

    function detailFields(fields) {
        const list = node('dl', '', 'cl-detail-fields');
        for (const [label, value] of fields) {
            const entry = node('div');
            entry.appendChild(node('dt', label));
            entry.appendChild(node('dd', value || unknown));
            list.appendChild(entry);
        }
        return list;
    }

    function measure(value, unit = '') {
        return Number.isFinite(value) ? detailNumber.format(value) + unit : unknown;
    }

    function packetLoss(lost, total) {
        if (!Number.isInteger(lost) || !Number.isInteger(total) || total < 20 || lost < 0 || lost > total) {
            return null;
        }
        return lost * 100 / total;
    }

    function timing(value) {
        return Number.isFinite(value) && value >= 0 ? value : null;
    }

    function qualityFactor(value, good, poor) {
        if (value === null) return 1;
        return 1 - Math.min(1, Math.max(0, (value - good) / (poor - good)));
    }

    function channelQuality(rtp) {
        if (!rtp) return null;
        const inbound = Number.isInteger(rtp.rx_packets) && rtp.rx_packets >= 0
            ? packetLoss(rtp.rx_lost, rtp.rx_packets + rtp.rx_lost) : null;
        const outbound = packetLoss(rtp.tx_lost, rtp.tx_packets);
        const losses = [inbound, outbound].filter((value) => value !== null);
        const jitter = timing(rtp.rx_jitter_ms);
        const rtt = timing(rtp.rtt_ms);
        if (!losses.length || (jitter === null && rtt === null)) return null;

        // Loss is a percentage. Jitter and round-trip time are in milliseconds.
        const loss = Math.max(...losses);
        const score = 100 * qualityFactor(loss, 0.1, 10) * qualityFactor(jitter, 20, 100)
            * qualityFactor(rtt, 150, 800);
        return {score: Math.round(score), partial: losses.length < 2 || jitter === null || rtt === null};
    }

    function callQuality(people, channelCount) {
        let score = null;
        let partial = people.length < channelCount;
        for (const {channel} of people) {
            const quality = channelQuality(channel.rtp);
            if (!quality) {
                partial = true;
                continue;
            }
            score = score === null ? quality.score : Math.min(score, quality.score);
            partial = partial || quality.partial;
        }
        return score === null ? null : {score, partial};
    }

    function qualityBadge(quality, missing = 'Недостаточно замеров RTP/RTCP') {
        const element = node('span', '', 'cl-quality');
        if (!quality) {
            element.appendChild(badge(unknown, 'neutral'));
            element.title = missing;
            return element;
        }
        const {score, partial} = quality;
        const tone = score >= 85 ? 'ok' : score >= 65 ? 'wait' : 'danger';
        element.appendChild(badge(score + '%', tone));
        element.title = 'Оценка по худшему измеренному каналу';
        if (partial) {
            element.title += '. Часть замеров недоступна';
            element.appendChild(node('small', 'частично', 'cl-quality-note'));
        }
        return element;
    }

    function channelDetails(item) {
        const {channel, extension, trunk} = item;
        const leg = node('article', '', 'cl-detail-leg');
        const direction = {in: 'Входящий', out: 'Исходящий'}[channel.direction];
        const label = extension ? [extension.extension, extension.name].filter(Boolean).join(' · ')
            : trunk ? ['Транк ' + trunkName(trunk), direction].filter(Boolean).join(' · ')
                : 'Канал ' + channel.name.split('/')[0];
        leg.appendChild(node('h3', label));
        leg.appendChild(node('p', channel.name, 'cl-detail-channel'));
        const location = [channel.exten, channel.context].filter(Boolean).join(' @ ');
        leg.appendChild(detailFields([
            ['Состояние канала', channel.held ? 'Удержание' : channel.state],
            ['Caller ID / Connected Line', [formatNumber(channel.caller) || unknown,
                formatNumber(channel.connected) || unknown].join(' / ')],
            ['Точка диалплана', location],
            ['Приложение Asterisk', channel.app],
            ['Uniqueid', channel.id],
            ['Linkedid', channel.linked],
            ['Мост Asterisk', [channel.bridge_type, channel.bridge].filter(Boolean).join(' · ')],
        ]));

        leg.appendChild(node('h4', 'Качество аудиоканала'));
        const codecs = channel.codecs || {};
        const rtp = channel.rtp || {};
        leg.appendChild(detailFields([
            ['Нативные кодеки', codecs.native],
            ['Формат чтения / записи в АТС', [codecs.read || unknown, codecs.write || unknown].join(' / ')],
            ['RTP принято / отправлено', measure(rtp.rx_packets) + ' / ' + measure(rtp.tx_packets)],
            ['Джиттер на приёме в АТС', measure(rtp.rx_jitter_ms, ' мс')],
            ['Потери на приёме в АТС', measure(rtp.rx_lost, ' пак.')],
            ['Потери по отчёту удалённой стороны', measure(rtp.tx_lost, ' пак.')],
            ['RTT по RTCP', measure(rtp.rtt_ms, ' мс')],
        ]));
        let note = 'Показатели RTP/RTCP появятся, когда их предоставит Asterisk. При прямой передаче RTP замеры на АТС могут быть недоступны.';
        if (!/^(PJSIP|SIP)\//i.test(channel.name)) {
            note = 'Измерения RTP/RTCP доступны для аудиоканалов SIP и PJSIP.';
        } else if (rtp.sampled_at) {
            const time = new Date(rtp.sampled_at * 1000).toLocaleTimeString('ru-RU');
            note = 'Снимок RTP/RTCP в ' + time + '. «—» означает, что замер недоступен.';
        }
        leg.appendChild(node('p', note, 'cl-detail-note'));
        return leg;
    }

    function renderCallDetail(data, assigned) {
        if (!selectedCall) return;
        const available = data.state === 'ready';
        const group = available && data.groups.find((item) =>
            connectedPhases.has(item.phase) && callKey(item) === selectedCall);
        const stateNode = byId('cl-detail-state');
        const age = byId('cl-detail-age');
        const quality = byId('cl-detail-quality');
        if (data.state === 'access_denied') {
            lastCall = null;
            detailSignature = '';
            byId('cl-detail-legs').textContent = '';
            age.textContent = '';
            quality.textContent = '';
            stateNode.textContent = 'Доступ завершён.';
            return;
        }
        if (!group) {
            const sameParticipants = available && lastCall && data.channels.some((channel) => lastCall.ids.has(channel.id));
            const status = available ? (sameParticipants ? 'Состав соединения изменился.' : 'Разговор завершён.')
                : 'Данные разговора временно недоступны.';
            if (stateNode.textContent !== status) stateNode.textContent = status;
            age.textContent = lastCall ? lastCall.age + ' · последний снимок ' + timeLabel(lastCall.at) : '';
            return;
        }
        const state = phases[group.phase][0];
        if (stateNode.textContent !== state) stateNode.textContent = state;
        lastCall = {ids: new Set(group.channels), age: 'С начала вызова ' + duration(group.age), at: data.updated_at};
        age.textContent = lastCall.age;
        const people = group.channels.map((id) => assigned.get(id)).filter(Boolean);
        const signature = JSON.stringify(people);
        if (signature === detailSignature) return;
        detailSignature = signature;
        quality.textContent = 'Качество ';
        quality.appendChild(qualityBadge(callQuality(people, group.channels.length)));
        const legs = byId('cl-detail-legs');
        legs.textContent = '';
        people.forEach((person) => legs.appendChild(channelDetails(person)));
    }

    function callRows(data, assigned) {
        const rows = [];
        for (const group of data.groups) {
            const people = group.channels.map((id) => assigned.get(id)).filter(Boolean);
            if (!people.length) continue;
            const row = node('tr');
            const phase = phases[group.phase] || phases.setup;
            const connected = connectedPhases.has(group.phase);
            cell(row, badge(phase[0], phase[1]));
            const participants = node('div', '', 'cl-participants');
            const trunks = new Set();
            people.forEach((person, position) => {
                if (position) {
                    const join = node('span', connected ? '↔' : '·', 'cl-join');
                    join.setAttribute('aria-hidden', 'true');
                    participants.appendChild(join);
                }
                participants.appendChild(participant(person));
                if (person.trunk) trunks.add(trunkName(person.trunk));
            });
            if (connected) {
                const key = callKey(group);
                const button = node('button', 'Подробнее', 'cl-detail-link');
                button.type = 'button';
                button.dataset.callKey = key;
                button.setAttribute('aria-haspopup', 'dialog');
                button.setAttribute('aria-controls', 'cl-detail');
                participants.appendChild(button);
                callButtons.set(key, button);
                row.className = 'cl-call-open';
                row.addEventListener('click', () => {
                    selectedCall = key;
                    renderCallDetail(data, assigned);
                    detailDialog.showModal();
                });
            }
            cell(row, participants);
            cell(row, Array.from(trunks).join(', ') || unknown);
            cell(row, connected ? qualityBadge(callQuality(people, group.channels.length))
                : qualityBadge(null, 'Оценка доступна после соединения и получения замеров'));
            cell(row, duration(group.age), 'cl-time');
            rows.push(row);
        }
        return rows;
    }

    function extensionState(hint, entries, connected) {
        const flags = hint > 0 ? hint : 0;
        const hasRing = Boolean(flags & 8) || entries.some((channel) => channel.state === 'ringing');
        const hasBridge = entries.some((channel) => connected.has(channel.id));
        const hasHold = Boolean(flags & 16) || entries.some((channel) => channel.held || connected.get(channel.id) === 'held');
        const inUse = Boolean(flags & 3) || entries.some((channel) => channel.state === 'up');

        if (hasHold) return [hasRing ? 'Удержание, второй вызов' : 'Удержание', 'wait', true];
        if (hasBridge && hasRing) return ['В разговоре, второй вызов', 'ok', true];
        if (hasBridge) return ['В разговоре', 'ok', true];
        if (entries.some((channel) => /off\s?hook/.test(channel.state))) return ['Снята трубка', 'wait', true];
        if (hasRing && inUse) return ['Занят, второй вызов', 'wait', true];
        if (hasRing) return ['Звонит', 'wait', true];
        if (entries.some((channel) => ['dialing', 'ring', 'pre-ring'].includes(channel.state))) return ['Дозвон', 'wait', true];
        if (inUse || entries.length) return ['Занят', 'wait', true];
        if (flags & 4) return ['Недоступен', 'danger', false];
        if (hint === 0) return ['Свободен', 'neutral', false];
        return ['Нет сигнала', 'neutral', false];
    }

    function apiUrl(command) {
        const url = new URL((window.FreePBX && window.FreePBX.ajaxurl) || 'ajax.php', window.location.href);
        url.searchParams.set('module', 'calllive');
        url.searchParams.set('command', command);
        return url;
    }

    function onOff(value, on = 'Включено', off = 'Выключено') {
        if (value === null || value === undefined) return unknown;
        if (/^(yes|on|1|true|enabled)$/i.test(String(value))) return on;
        return /^(no|off|0|false|disabled)?$/i.test(String(value)) ? off : unknown;
    }

    function forwarding(value) {
        return value === '' ? 'Выключена' : value;
    }

    function detailCard(title, fields) {
        const card = node('article', '', 'cl-detail-leg');
        card.appendChild(node('h3', title));
        card.appendChild(detailFields(fields));
        return card;
    }

    function sipFields(endpoint) {
        const states = {
            'Not in use': 'Свободен', 'In use': 'Используется', Unavailable: 'Недоступен',
            Busy: 'Занят', Ringing: 'Звонит', 'On Hold': 'Удержание', Unknown: 'Неизвестно',
            Unmonitored: 'Без контроля доступности',
        };
        const aors = endpoint.aor_details || [];
        const contacts = aors.flatMap((aor) => aor.contacts || []);
        return [
            ['Состояние Asterisk', states[endpoint.state] || endpoint.state],
            ['Адрес', Array.from(new Set(contacts)).join(', ') || [endpoint.ip, endpoint.port].filter(Boolean).join(':')],
            ['Транспорт', endpoint.transport],
            ['Кодеки', endpoint.codecs],
            ['Контекст', endpoint.context],
            ['AoR', endpoint.aors],
            ['Регистрации по AoR', aors.filter((aor) => aor.registered !== null)
                .map((aor) => aor.name + ' · ' + aor.registered).join(', ')],
            ['Проверка доступности', aors.filter((aor) => aor.qualify !== null)
                .map((aor) => aor.name + ' · ' + (Number(aor.qualify) > 0 ? aor.qualify + ' с' : 'Выключена')).join(', ')],
            ['DTMF', endpoint.dtmf],
            ['Шифрование медиа', endpoint.encryption],
            ['Прямое медиа', onOff(endpoint.direct_media)],
            ['SIP-устройство', endpoint.agent],
        ];
    }

    function renderEntityDetail(selection, result) {
        const body = byId('cl-entity-legs');
        const status = byId('cl-entity-status');
        if (result.state !== 'ready') {
            status.textContent = result.state === 'missing' ? 'Запись отсутствует в справочнике.'
                : 'Дополнительные сведения временно недоступны.';
            return;
        }
        status.textContent = 'Сведения получены в ' + new Date().toLocaleTimeString('ru-RU');
        const entry = result.entry;
        const signature = JSON.stringify(result);
        if (selection.signature === signature) return;
        selection.signature = signature;
        body.textContent = '';
        if (selection.kind === 'extension') {
            const features = result.features || {};
            const follow = {DIRECT: 'Включён', EXTENSION: 'Выключен', '': 'Не настроен'}[features.followme];
            body.appendChild(detailCard('Услуги номера', [
                ['DND в АТС', onOff(features.DND, 'Включён', 'Выключен')],
                ['FWD для всех вызовов', forwarding(features.CF)],
                ['FWD при занятости', forwarding(features.CFB)],
                ['FWD при неответе или недоступности', forwarding(features.CFU)],
                ['Ожидание второго вызова', onOff(features.CW)],
                ['Follow Me', follow],
                ['Номера Follow Me', features.followme_list],
            ]));
            body.appendChild(detailCard('Настройки FreePBX', [
                ['Исходящий Caller ID', entry.outboundcid],
                ['Голосовая почта', entry.voicemail && entry.voicemail !== 'novm' ? entry.voicemail : 'Не настроена'],
                ['Время дозвона', Number(entry.ringtimer) > 0 ? entry.ringtimer + ' с' : 'По умолчанию'],
            ]));
            for (const device of result.devices || []) {
                body.appendChild(detailCard('Устройство ' + device.id, [
                    ['Описание', device.description],
                    ['Тип', techName(device.tech)],
                    ['Привязка', {fixed: 'Постоянная', adhoc: 'Динамическая'}[device.devicetype] || device.devicetype],
                    ['Набор', device.dial],
                    ...sipFields(device.endpoint || {}),
                ]));
            }
        } else {
            body.appendChild(detailCard('Настройки транка', [
                ['Тип', techName(entry.tech)],
                ['Endpoint / peer', entry.channelid],
                ['Разрешён в FreePBX', entry.disabled === 'on' ? 'Нет' : 'Да'],
                ['Лимит каналов', Number(entry.maxchans) > 0 ? String(entry.maxchans) : 'Без ограничения'],
                ['Исходящий Caller ID', entry.outcid],
                ['Префикс набора', entry.dialoutprefix],
                ['Провайдер', entry.provider],
                ['Входящий контекст', entry.usercontext],
                ['Переход к следующему транку', onOff(entry.continue)],
                ['Исходящие маршруты', (result.routes || []).map((route) => route.name).filter(Boolean).join(', ') || 'Не назначены'],
            ]));
            if (['PJSIP', 'SIP'].includes(techName(entry.tech))) {
                const settings = result.settings || {};
                body.appendChild(detailCard('Сигнализация', [
                    ['Сервер SIP', [settings.sip_server, settings.sip_server_port].filter(Boolean).join(':')],
                    ['Режим регистрации', {send: 'Исходящая', receive: 'Входящая', none: 'Без регистрации'}[settings.registration]],
                    ['Исходящая регистрация', result.registration],
                    ...sipFields(result.endpoint || {}),
                ]));
            }
        }
    }

    function entityLive(kind, id, state, channels) {
        if (!selectedEntity || selectedEntity.kind !== kind || selectedEntity.id !== id) return;
        const summary = state + ' · Каналов ' + channels.length + (channels.length
            ? ' · ' + channels.map((channel) => channel.name).join(', ') : '');
        const line = byId('cl-entity-live');
        if (line.textContent !== summary) line.textContent = summary;
    }

    async function refreshEntity(selection) {
        const controller = new AbortController();
        entityRequest = controller;
        const timer = window.setTimeout(() => controller.abort(), 4500);
        try {
            const url = apiUrl(selection.kind);
            url.searchParams.set('id', selection.id);
            const response = await fetch(url, {
                mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
                headers: {'Accept': 'application/json'}, signal: controller.signal,
            });
            if (selection !== selectedEntity) return;
            if (response.status === 401 || response.status === 403) {
                snapshot = null;
                inventory = null;
                paint({state: 'access_denied'});
                return;
            }
            if (!response.ok) throw new Error('CallLive details request failed');
            const result = await response.json();
            if (selection === selectedEntity) renderEntityDetail(selection, result);
        } catch (error) {
            if (selection === selectedEntity) renderEntityDetail(selection, {state: 'unavailable'});
        } finally {
            window.clearTimeout(timer);
            if (entityRequest === controller) entityRequest = null;
            if (selection === selectedEntity) {
                entityTimer = window.setTimeout(() => refreshEntity(selection), 10000);
            }
        }
    }

    function entityRow(row, kind, id, label, state, channels) {
        const key = kind + ':' + id;
        const button = node('button', label, 'cl-detail-link cl-entity-link');
        button.type = 'button';
        button.dataset.entityKey = key;
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-controls', 'cl-entity');
        entityButtons.set(key, button);
        row.className = 'cl-call-open';
        row.addEventListener('click', () => {
            const selection = {kind, id, key, signature: ''};
            selectedEntity = selection;
            byId('cl-entity-title').textContent = (kind === 'trunk' ? 'Транк ' : 'Внутренний номер ') + label;
            byId('cl-entity-legs').textContent = '';
            byId('cl-entity-status').textContent = 'Загрузка сведений…';
            entityLive(kind, id, state, channels);
            entityDialog.showModal();
            refreshEntity(selection);
        });
        return button;
    }

    function renderExtensions() {
        const search = byId('cl-search').value.trim().toLocaleLowerCase();
        const filtered = extensions.filter(({entry}) => (
            (String(entry.extension) + ' ' + (entry.name || '')).toLocaleLowerCase().includes(search)
        ));
        const rows = filtered.map(({entry, state, channels}) => {
            const row = node('tr');
            const name = node('div', '', 'cl-participant');
            name.appendChild(entityRow(row, 'extension', String(entry.extension), String(entry.extension), state[0], channels));
            if (entry.name) name.appendChild(node('small', entry.name));
            cell(row, name);
            cell(row, badge(state[0], state[1]));
            cell(row, String(channels.length), 'cl-time');
            return row;
        });
        const message = search && extensions.length ? 'Номера по этому запросу не найдены.' : 'Внутренние номера не загружены.';
        table('cl-extensions', rows, 3, message);
    }

    function paint(data) {
        const state = health[data.state] || health.collector_unavailable;
        const status = byId('cl-status');
        if (status.textContent !== state[0]) status.textContent = state[0];
        status.dataset.tone = state[1];
        const notice = byId('cl-notice');
        const details = [state[2]];
        if (inventoryError) details.push('Справочник FreePBX временно недоступен.');
        const daily = data.daily;
        if (daily && daily.storage_error) details.push('Суточные счётчики пока сохраняются только в памяти.');
        const day = daily && typeof daily.date === 'string' ? daily.date.split('-').reverse().join('.') + ' ' : '';
        byId('cl-daily-date').textContent = 'За сутки ' + day + 'по времени АТС';
        byId('cl-daily-peak').textContent = daily ? measure(daily.peak) : unknown;
        byId('cl-daily-longest').textContent = daily ? formatDuration(daily.longest) : unknown;
        notice.textContent = details.filter(Boolean).join(' ');
        notice.hidden = !notice.textContent;

        if (data.state !== 'ready') {
            byId('cl-updated').textContent = '';
            for (const id of ['cl-count-connections', 'cl-count-trunks', 'cl-count-extensions']) {
                byId(id).textContent = unknown;
            }
            callButtons.clear();
            entityButtons.clear();
            table('cl-calls', [], 5, 'Текущие вызовы недоступны.');
            table('cl-trunks', [], 3, 'Текущая загрузка транков недоступна.');
            table('cl-extensions', [], 3, 'Текущие состояния номеров недоступны.');
            extensions = [];
            renderCallDetail(data);
            if (selectedEntity) {
                byId('cl-entity-live').textContent = 'Текущие каналы недоступны.';
                if (data.state === 'access_denied') {
                    byId('cl-entity-legs').textContent = '';
                    closeEntity();
                    entityDialog.close();
                }
            }
            return;
        }

        byId('cl-updated').textContent = 'Снимок ' + timeLabel(data.updated_at);
        const lookup = buildLookups(inventory || {extensions: [], trunks: [], devices: []}, data.hints);
        const assigned = new Map();
        const byExtension = new Map();
        const byTrunk = new Map();
        for (const channel of data.channels) {
            const item = assign(channel, lookup);
            assigned.set(channel.id, item);
            if (item.extension) index(byExtension, String(item.extension.extension), channel);
            if (item.trunk) index(byTrunk, String(item.trunk.trunkid), channel);
        }

        const live = data.groups.filter((group) => connectedPhases.has(group.phase));
        const connected = new Map();
        live.forEach((group) => group.channels.forEach((id) => connected.set(id, group.phase)));
        byId('cl-count-connections').textContent = String(live.length);
        byId('cl-count-trunks').textContent = inventory ? String(byTrunk.size) : unknown;
        const focused = document.activeElement;
        const focusedKey = focused && focused.dataset && focused.dataset.callKey;
        const entityFocus = focused && focused.dataset && focused.dataset.entityKey;
        callButtons.clear();
        entityButtons.clear();
        table('cl-calls', callRows(data, assigned), 5, 'Сейчас нет активных вызовов.');
        if (focusedKey) (callButtons.get(focusedKey) || byId('cl-calls-title')).focus({preventScroll: true});
        renderCallDetail(data, assigned);

        const trunkRows = (inventory ? inventory.trunks : []).map((trunk) => {
            const row = node('tr');
            const id = String(trunk.trunkid);
            const channels = Array.from(byTrunk.get(id) || []);
            const count = channels.length;
            const key = dialKey(techName(trunk.tech) + '/' + trunk.channelid);
            const ambiguous = key && (lookup.trunks.get(key).size > 1
                || lookup.hintDevices.has(key) || lookup.fixedDevices.has(key));
            const disabled = trunk.disabled === 'on';
            const status = count ? ['Используется', 'ok'] : !key ? ['Вне сопоставления', 'neutral']
                : ambiguous ? ['Неоднозначное сопоставление', 'wait']
                : disabled ? ['Отключён в настройках', 'neutral'] : ['0 сопоставленных каналов', 'neutral'];
            const name = node('div', '', 'cl-participant');
            name.appendChild(entityRow(row, 'trunk', id, trunkName(trunk), status[0], channels));
            name.appendChild(node('small', techName(trunk.tech) + '/' + trunk.channelid));
            cell(row, name);
            cell(row, badge(status[0], status[1]));
            cell(row, key && !ambiguous ? String(count) : unknown, 'cl-time');
            entityLive('trunk', id, status[0], channels);
            return row;
        });
        table('cl-trunks', trunkRows, 3, 'Транки не загружены.');

        extensions = Array.from(lookup.numbers, ([ext, entry]) => {
            const channels = Array.from(byExtension.get(ext) || []);
            const state = extensionState(lookup.states.get(ext), channels, connected);
            entityLive('extension', ext, state[0], channels);
            return {entry, state, channels};
        });
        byId('cl-count-extensions').textContent = inventory
            ? String(extensions.filter(({state}) => state[2]).length) : unknown;
        renderExtensions();
        if (entityFocus && entityButtons.has(entityFocus)) entityButtons.get(entityFocus).focus({preventScroll: true});
    }

    async function refresh() {
        let stop = false;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 4500);
        try {
            const url = apiUrl('snapshot');
            if (Date.now() - inventoryChecked >= (inventoryError ? 5000 : 30000)) url.searchParams.set('inventory', '1');
            const response = await fetch(url, {
                mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
                headers: {'Accept': 'application/json'}, signal: controller.signal,
            });
            if (response.status === 401 || response.status === 403) {
                stop = true;
                snapshot = null;
                paint({state: 'access_denied'});
                return;
            }
            if (!response.ok) throw new Error('CallLive request failed');
            const data = await response.json();
            if (url.searchParams.has('inventory')) {
                inventoryChecked = Date.now();
                inventoryError = Boolean(data.inventory_error);
                if (data.inventory) inventory = data.inventory;
            }
            if (!snapshot || data.updated_at !== snapshot.updated_at) receivedAt = performance.now();
            snapshot = data;
            paint(data);
        } catch (error) {
            snapshot = null;
            paint({state: 'request_error'});
        } finally {
            window.clearTimeout(timer);
            if (!stop) window.setTimeout(refresh, 1000);
        }
    }

    detailDialog.addEventListener('close', () => {
        const trigger = callButtons.get(selectedCall) || byId('cl-calls-title');
        selectedCall = '';
        detailSignature = '';
        lastCall = null;
        byId('cl-detail-legs').textContent = '';
        byId('cl-detail-quality').textContent = '';
        trigger.focus({preventScroll: true});
    });
    function closeEntity() {
        if (entityRequest) entityRequest.abort();
        if (entityTimer !== null) window.clearTimeout(entityTimer);
        selectedEntity = null;
        entityTimer = null;
    }
    entityDialog.addEventListener('close', () => {
        const selection = selectedEntity;
        closeEntity();
        byId('cl-entity-legs').textContent = '';
        if (selection) {
            const fallback = selection.kind === 'trunk' ? 'cl-trunks-title' : 'cl-extensions-title';
            (entityButtons.get(selection.key) || byId(fallback)).focus({preventScroll: true});
        }
    });
    byId('cl-search').addEventListener('input', () => {
        if (snapshot && snapshot.state === 'ready') renderExtensions();
    });
    refresh();
})();
