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
        access_denied: ['Доступ завершён', 'danger', 'Войдите в FreePBX с доступом к разделу «Монитор телефонии» и обновите страницу.'],
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
    let currentView = 'monitor';
    let thresholds = {quality: 65, loss: 2, wait: 30, sustain: 10};
    let problems = new Map();
    let recordSelection = null;
    let recordTimer = null;
    let recordRequest = null;
    let shownRecord = null;
    let historyCursor = null;
    let historyRecords = [];
    let historyGeneration = 0;
    let statisticsData = {};
    let diagnosis = null;
    let accessEpoch = 0;
    let pbxDatesInitialized = false;

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
        return group.call_id || JSON.stringify(group.channels);
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
        if (!rtp || (rtp.sampled_at && snapshot && snapshot.updated_at - rtp.sampled_at > 15)) return null;
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
        return {score: Math.round(score), partial: losses.length < 2 || jitter === null || rtt === null,
            loss, jitter, rtt, factors: {loss: qualityFactor(loss, 0.1, 10),
                jitter: qualityFactor(jitter, 20, 100), rtt: qualityFactor(rtt, 150, 800)}};
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
        if (!selectedCall || (recordSelection && recordSelection.archived)) return;
        const available = data.state === 'ready';
        const group = available && data.groups.find((item) =>
            callKey(item) === selectedCall);
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
            const foundProblems = problems.get(callKey(group)) || [];
            const activeProblems = foundProblems.filter((problem) => problem.active);
            const filter = byId('cl-problem-filter').value || 'all';
            if (filter !== 'all' && !activeProblems.some((problem) => filter === 'problems' || problem.kind === filter)) continue;
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
            if (connected || group.call_id) {
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
                    if (group.call_id) openRecord(group.call_id, false);
                    detailDialog.showModal();
                });
            }
            if (activeProblems.length) participants.appendChild(node('small', activeProblems.map((p) => p.label).join(' · '), 'cl-problem-text'));
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
        if (data.thresholds) {
            if (JSON.stringify(data.thresholds) !== JSON.stringify(thresholds)) problems.clear();
            thresholds = data.thresholds;
        }
        updateProblems(data);
        if (data.state === 'access_denied') clearPrivateViews();
        const state = health[data.state] || health.collector_unavailable;
        const status = byId('cl-status');
        if (status.textContent !== state[0]) status.textContent = state[0];
        status.dataset.tone = state[1];
        const notice = byId('cl-notice');
        const details = [state[2]];
        if (inventoryError) details.push('Справочник FreePBX временно недоступен.');
        if (data.collector_version !== '15.0.8' && data.state === 'ready') details.push('Для истории, графиков и статистики обновите сборщик до 15.0.8: вкладка «Диагностика и обновление».');
        if (data.journal && data.journal.storage_error) details.push('История не сохраняется: проверьте диск и права каталога /var/lib/freepbx-calllive.');
        if (data.journal && (data.journal.capacity_exceeded || data.journal.capacity_drops)) details.push('Достигнут предел хранения истории; часть вызовов могла не сохраниться. Подробности в диагностике.');
        const daily = data.daily;
        if (!pbxDatesInitialized && daily && /^\d{4}-\d{2}-\d{2}$/.test(daily.date)) {
            pbxDatesInitialized = true;
            for (const key of ['cl-history-from', 'cl-history-to', 'cl-statistics-to']) byId(key).value = daily.date;
            const prior = new Date(daily.date + 'T12:00:00'); prior.setDate(prior.getDate() - 6);
            byId('cl-statistics-from').value = localDate(prior);
        }
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
        const trigger = callButtons.get(selectedCall) || byId(currentView === 'history' ? 'cl-history-title' : 'cl-calls-title');
        selectedCall = '';
        detailSignature = '';
        lastCall = null;
        byId('cl-detail-legs').textContent = '';
        byId('cl-detail-quality').textContent = '';
        closeRecord();
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
    function localDate(date = new Date()) {
        return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    }

    function dateTime(timestamp) {
        return Number.isFinite(timestamp) ? new Date(timestamp * 1000).toLocaleString('ru-RU') : unknown;
    }

    function updateProblems(data) {
        if (data.state !== 'ready') {
            problems.clear();
            byId('cl-alerts').hidden = true;
            return;
        }
        const previous = problems;
        problems = new Map();
        for (const group of data.groups || []) {
            const key = callKey(group);
            const channels = (data.channels || []).filter((c) => group.channels.includes(c.id));
            const measured = channels.map((c) => channelQuality(c.rtp)).filter(Boolean);
            const quality = measured.length ? Math.min(...measured.map((q) => q.score)) : null;
            const loss = measured.length ? Math.max(...measured.map((q) => q.loss)) : null;
            const candidates = [];
            if (connectedPhases.has(group.phase) && quality !== null && quality < thresholds.quality) candidates.push(['quality', 'Качество ' + quality + '%']);
            if (connectedPhases.has(group.phase) && loss !== null && loss > thresholds.loss) candidates.push(['loss', 'Потери ' + measure(loss, '%')]);
            if (['ringing', 'queue', 'waiting', 'parked'].includes(group.phase) && group.age >= thresholds.wait) candidates.push(['wait', 'Ожидание ' + formatDuration(group.age)]);
            const entries = candidates.map(([kind, label]) => {
                const old = (previous.get(key) || []).find((p) => p.kind === kind);
                const since = old ? old.since : data.updated_at;
                return {kind, label, since, active: data.updated_at - since >= thresholds.sustain};
            });
            if (entries.length) problems.set(key, entries);
        }
        const active = [...problems.values()].flat().filter((p) => p.active);
        const alerts = byId('cl-alerts');
        alerts.textContent = active.length ? 'Проблемы в текущих вызовах: ' + active.map((p) => p.label).join('; ') + '.' : '';
        alerts.hidden = !active.length;
    }

    async function apiRead(command, params = {}) {
        const epoch = accessEpoch;
        const url = apiUrl(command);
        for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, value);
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 6000);
        try {
            const response = await fetch(url, {mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
                headers: {'Accept': 'application/json'}, signal: controller.signal});
            if (response.status === 401 || response.status === 403) {
                paint({state: 'access_denied'});
                throw new Error('Доступ завершён.');
            }
            if (!response.ok) throw new Error('Ошибка запроса к FreePBX.');
            const result = await response.json();
            if (epoch !== accessEpoch) throw new Error('Доступ завершён.');
            return result;
        } finally { window.clearTimeout(timer); }
    }

    function clearPrivateViews() {
        snapshot = null;
        inventory = null;
        extensions = [];
        problems.clear();
        accessEpoch++;
        closeRecord();
        historyGeneration++;
        historyRecords = [];
        historyCursor = null;
        statisticsData = {};
        diagnosis = null;
        for (const id of ['cl-history', 'cl-statistics', 'cl-trunk-peaks', 'cl-load-chart', 'cl-hour-chart', 'cl-diagnostics-fields']) byId(id).textContent = '';
        byId('cl-update').hidden = true;
        byId('cl-update-command').value = '';
        byId('cl-history-more').hidden = true;
        for (const name of ['history', 'statistics', 'diagnostics']) byId('cl-' + name + '-status').textContent = 'Доступ завершён.';
    }

    function closeRecord() {
        if (recordRequest) recordRequest.abort();
        if (recordTimer !== null) window.clearTimeout(recordTimer);
        recordSelection = null;
        recordTimer = null;
        shownRecord = null;
        byId('cl-insights').hidden = true;
        for (const id of ['cl-record-summary', 'cl-quality-explanation', 'cl-quality-charts', 'cl-timeline', 'cl-record-notice']) byId(id).textContent = '';
    }

    function openRecord(id, archived) {
        closeRecord();
        const selection = {id, archived, signature: ''};
        recordSelection = selection;
        byId('cl-insights').hidden = false;
        byId('cl-record-notice').textContent = 'Загрузка сохранённых технических данных…';
        if (archived) {
            selectedCall = id;
            byId('cl-detail-legs').textContent = '';
            byId('cl-detail-quality').textContent = '';
            byId('cl-detail-age').textContent = '';
            byId('cl-detail-state').textContent = 'История разговора';
            detailDialog.showModal();
        }
        refreshRecord(selection);
    }

    async function refreshRecord(selection) {
        const controller = new AbortController();
        recordRequest = controller;
        const timer = window.setTimeout(() => controller.abort(), 4500);
        let finished = false;
        try {
            const url = apiUrl('call');
            url.searchParams.set('id', selection.id);
            const response = await fetch(url, {credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
                headers: {'Accept': 'application/json'}, signal: controller.signal});
            if (selection !== recordSelection) return;
            if (response.status === 401 || response.status === 403) { paint({state: 'access_denied'}); return; }
            if (!response.ok) throw new Error('Ошибка запроса.');
            const result = await response.json();
            if (selection !== recordSelection) return;
            if (result.state !== 'ready') {
                byId('cl-record-notice').textContent = 'Запись пока не сохранена или уже удалена по сроку хранения. Последние показанные данные остаются в окне.';
                return;
            }
            const record = result.record;
            finished = record.status !== 'active';
            const signature = JSON.stringify(record);
            if (selection.signature !== signature) {
                selection.signature = signature;
                shownRecord = record;
                renderRecord(record);
            }
        } catch (error) {
            if (selection === recordSelection) byId('cl-record-notice').textContent = 'Не удалось обновить сохранённые данные. Последние данные остаются в окне.';
        } finally {
            window.clearTimeout(timer);
            if (recordRequest === controller) recordRequest = null;
            if (!finished && selection === recordSelection) recordTimer = window.setTimeout(() => refreshRecord(selection), 5000);
        }
    }

    const eventNames = {
        start: 'Начало наблюдения вызова', observed: 'Вызов уже существовал при подключении сборщика', channel: 'Создан канал',
        dialbegin: 'Начало дозвона', dialend: 'Результат дозвона', ringing: 'Дозвон', connected: 'Разговор',
        held: 'Удержание', hold: 'Удержание', unhold: 'Снятие с удержания', conference: 'Групповое соединение',
        queue: 'В очереди', queuecallerjoin: 'Вход в очередь', queuecallerleave: 'Выход из очереди',
        agentconnect: 'Соединение с оператором', agentcomplete: 'Завершение у оператора',
        blindtransfer: 'Перевод без консультации', attendedtransfer: 'Перевод с консультацией',
        hangup: 'Завершён канал', end: 'Вызов завершён', gap: 'Потеряно наблюдение AMI', resumed: 'Наблюдение восстановлено',
        parked: 'Парковка', waiting: 'Ожидание', service: 'Сервис АТС', setup: 'Создание соединения',
    };

    function renderRecord(record) {
        byId('cl-record-summary').textContent = 'Начало: ' + dateTime(record.started_at)
            + ' · Ответ: ' + dateTime(record.answered_at) + ' · Завершение: ' + dateTime(record.ended_at)
            + ' · Наблюдаемый разговор: ' + formatDuration(Math.floor(record.talk_seconds))
            + (record.gap ? ' · Есть неполный период наблюдения.' : '');
        const quality = record.last_quality;
        const worst = record.worst_quality;
        byId('cl-quality-explanation').textContent = '';
        byId('cl-quality-explanation').appendChild(node('p',
            'Оценка = 100 × коэффициент потерь × коэффициент джиттера × коэффициент RTT. Берётся худший измеренный канал. '
            + 'Потери: 100% коэффициента до 0,1%, 0% при 10%; джиттер: до 20 мс / от 100 мс; RTT: до 150 мс / от 800 мс. '
            + 'Между границами коэффициент уменьшается линейно. Это расчётный показатель, а не MOS и не анализ слышимости речи.', 'cl-detail-note'));
        byId('cl-quality-explanation').appendChild(detailFields([
            ['Последнее качество', quality ? quality.score + '% · ' + timeLabel(quality.at) + (quality.partial ? ' · частичные данные' : '') : 'Недостаточно замеров'],
            ['Худшее качество', worst ? worst.score + '% · ' + timeLabel(worst.at) + (worst.partial ? ' · частичные данные' : '') : unknown],
            ['Покрытие последнего замера', quality ? quality.coverage[0] + ' из ' + quality.coverage[1] + ' каналов' : unknown],
        ]));
        const latest = record.samples.length ? record.samples[record.samples.length - 1] : null;
        if (latest) for (const q of latest.channels) {
            const channel = record.channels.find((c) => c.id === q.id);
            byId('cl-quality-explanation').appendChild(detailCard(channel ? channel.name : q.id, [
                ['Качество канала', q.score + '%' + (q.partial ? ' · частично' : '')],
                ['Потери', measure(q.loss, '%') + ' · множитель ' + measure(q.factors.loss)],
                ['Джиттер', measure(q.jitter, ' мс') + ' · множитель ' + measure(q.factors.jitter)],
                ['RTT', measure(q.rtt, ' мс') + ' · множитель ' + measure(q.factors.rtt)],
                ['Время замера', dateTime(q.sampled_at)],
            ]));
        }
        const selector = byId('cl-chart-channel');
        const old = selector.value;
        selector.textContent = '';
        const option = node('option', 'Худшие измерения всех каналов'); option.value = ''; selector.appendChild(option);
        for (const c of record.channels) { const o = node('option', c.name); o.value = c.id; selector.appendChild(o); }
        selector.value = record.channels.some((c) => c.id === old) ? old : '';
        renderQualityCharts();
        const timeline = byId('cl-timeline'); timeline.textContent = '';
        for (const event of record.timeline) {
            const entry = node('li');
            entry.appendChild(node('time', timeLabel(event.at)));
            entry.appendChild(node('strong', eventNames[event.kind] || event.kind));
            entry.appendChild(node('span', [event.channel, event.queue && 'Очередь ' + event.queue,
                event.target, event.result, event.cause && 'Cause ' + event.cause, event.reason].filter(Boolean).join(' · ')));
            timeline.appendChild(entry);
        }
        const causes = (record.causes || []).map((c) => c.channel + ': ' + c.code + ' ' + c.text);
        byId('cl-record-notice').textContent = [causes.length ? 'Причины завершения по Asterisk: ' + causes.join('; ') : '',
            record.status !== 'active' && !causes.length ? 'Причина завершения не получена от Asterisk.' : '',
            record.stale ? 'Последний снимок устарел, состояние вызова сейчас неизвестно.' : '',
            record.limited ? 'Длинная запись сокращена: на графике сохранены худшие точки соседних интервалов; часть ранних промежуточных событий опущена.' : '',
            record.gap ? 'Есть пропуск наблюдения; длительность и последовательность могут быть неполными.' : '',
        ].filter(Boolean).join(' ');
        if (record.status !== 'active' || recordSelection.archived) {
            byId('cl-detail-state').textContent = record.status === 'active' ? 'Вызов ещё активен' : 'Разговор завершён. Данные сохранены.';
            byId('cl-detail-age').textContent = 'Весь вызов ' + formatDuration(Math.max(0, (record.ended_at || record.last_seen) - record.started_at));
            byId('cl-detail-quality').textContent = 'Качество ';
            byId('cl-detail-quality').appendChild(qualityBadge(quality));
            const lookup = buildLookups(inventory || {extensions: [], devices: [], trunks: []}, []);
            const legs = byId('cl-detail-legs'); legs.textContent = '';
            for (const c of record.channels) legs.appendChild(channelDetails(assign(c, lookup)));
        }
    }

    function svgNode(tag, attrs, value = '') {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [name, v] of Object.entries(attrs || {})) el.setAttribute(name, String(v));
        if (value) el.textContent = value;
        return el;
    }

    function lineChart(title, values, unit, fixedMax = null) {
        const box = node('figure', '', 'cl-chart');
        box.appendChild(node('figcaption', title));
        const known = values.filter((p) => Number.isFinite(p.value));
        if (!known.length) { box.appendChild(node('p', 'Замеры недоступны', 'cl-detail-note')); return box; }
        const svg = svgNode('svg', {viewBox: '0 0 440 160', role: 'img', 'aria-label': title});
        const minT = values[0].at; const maxT = values[values.length - 1].at;
        const maximum = fixedMax || Math.max(1, ...known.map((p) => p.value)) * 1.1;
        const x = (t) => 42 + (t - minT) / Math.max(1, maxT - minT) * 380;
        const y = (v) => 130 - Math.min(maximum, v) / maximum * 105;
        for (const v of [0, maximum / 2, maximum]) {
            svg.appendChild(svgNode('line', {x1: 42, x2: 422, y1: y(v), y2: y(v), stroke: '#d9e3e9'}));
            svg.appendChild(svgNode('text', {x: 37, y: y(v) + 4, 'text-anchor': 'end'}, detailNumber.format(v)));
        }
        let path = ''; let previous = null;
        for (const p of values) {
            if (!Number.isFinite(p.value)) { previous = null; continue; }
            const breakLine = !previous || p.at - previous.at > Math.max(20, (shownRecord ? shownRecord.sample_interval : 5) * 3);
            path += (breakLine ? 'M' : 'L') + x(p.at).toFixed(2) + ',' + y(p.value).toFixed(2) + ' ';
            previous = p;
        }
        svg.appendChild(svgNode('path', {d: path, fill: 'none', stroke: '#187a7c', 'stroke-width': 2}));
        for (const p of known) {
            const dot = svgNode('circle', {cx: x(p.at), cy: y(p.value), r: 2.5, fill: '#187a7c'});
            dot.appendChild(svgNode('title', {}, dateTime(p.at) + ': ' + measure(p.value, unit)));
            svg.appendChild(dot);
        }
        svg.appendChild(svgNode('text', {x: 42, y: 151}, timeLabel(minT)));
        svg.appendChild(svgNode('text', {x: 422, y: 151, 'text-anchor': 'end'}, timeLabel(maxT)));
        box.appendChild(svg);
        return box;
    }

    function renderQualityCharts() {
        if (!shownRecord) return;
        const body = byId('cl-quality-charts'); body.textContent = '';
        const selected = byId('cl-chart-channel').value;
        const metrics = [['score', 'Качество, %', '%', 100], ['loss', 'Потери пакетов, %', '%'],
            ['jitter', 'Джиттер на приёме, мс', ' мс'], ['rtt', 'RTT, мс', ' мс']];
        for (const [key, label, unit, max] of metrics) {
            const values = shownRecord.samples.map((sample) => {
                const known = sample.channels.filter((c) => (!selected || c.id === selected) && Number.isFinite(c[key]));
                return {at: sample.at, value: known.length ? (key === 'score' ? Math.min : Math.max)(...known.map((c) => c[key])) : null};
            });
            body.appendChild(lineChart(label, values, unit, max));
        }
        byId('cl-chart-note').textContent = 'Точки — доступные замеры Asterisk, обычно раз в 5 секунд. Показатель потерь рассчитан из сообщённых счётчиков; это не измерение потерь между соседними точками. '
            + 'Пропуски замеров остаются пропусками. Интервал сохранения до ' + shownRecord.sample_interval + ' с. Наведите на точку для значения и времени.';
    }

    function historyParams(more) {
        return {from: byId('cl-history-from').value, to: byId('cl-history-to').value,
            search: byId('cl-history-search').value.trim(), problem: byId('cl-history-problem').checked ? '1' : '0',
            cursor: more ? historyCursor : null};
    }

    async function loadHistory(more = false) {
        const generation = ++historyGeneration;
        if (!more) { historyRecords = []; historyCursor = null; }
        byId('cl-history-status').textContent = 'Поиск…';
        byId('cl-history-more').hidden = true;
        try {
            const result = await apiRead('history', historyParams(more));
            if (generation !== historyGeneration) return;
            if (result.state !== 'ready') throw new Error('Укажите корректный диапазон дат до 31 дня.');
            const seen = new Set(historyRecords.map((r) => r.id));
            historyRecords.push(...result.records.filter((r) => !seen.has(r.id)));
            historyCursor = result.cursor;
            const rows = historyRecords.map((r) => {
                const row = node('tr');
                cell(row, dateTime(r.started_at) + ' → ' + dateTime(r.ended_at));
                const people = node('div', '', 'cl-participant');
                const trigger = node('button', r.participants.join(' ↔ ') || 'Подробнее', 'cl-detail-link');
                trigger.type = 'button';
                trigger.addEventListener('click', () => openRecord(r.id, true));
                people.appendChild(trigger);
                people.appendChild(node('small', r.endpoints.join(', ')));
                callButtons.set(r.id, trigger);
                cell(row, people);
                cell(row, formatDuration(r.talk_seconds) + ' / ' + formatDuration(r.duration));
                const scores = node('span'); scores.appendChild(qualityBadge(r.last_quality)); scores.appendChild(node('span', ' / ')); scores.appendChild(qualityBadge(r.worst_quality)); cell(row, scores);
                cell(row, (r.answered ? 'С ответом' : 'Без подтверждённого ответа') + (r.gap ? ' · неполные данные' : ''));
                return row;
            });
            table('cl-history', rows, 5, 'За выбранный период вызовы не найдены.');
            byId('cl-history-status').textContent = !result.available ? 'История пока недоступна: проверьте версию и работу сборщика.'
                : 'Показано: ' + historyRecords.length + '. ' + (result.partial ? 'Поиск ограничен по времени; нажмите «Ещё вызовы», чтобы продолжить.' : 'Откройте вызов для технических данных.');
            byId('cl-history-more').hidden = !historyCursor;
        } catch (error) { if (generation === historyGeneration) byId('cl-history-status').textContent = error.message; }
    }

    function bars(title, entries) {
        const box = node('figure', '', 'cl-chart'); box.appendChild(node('figcaption', title));
        if (!entries.length) { box.appendChild(node('p', 'Нет наблюдений', 'cl-detail-note')); return box; }
        const svg = svgNode('svg', {viewBox: '0 0 900 210', role: 'img', 'aria-label': title});
        const maximum = Math.max(1, ...entries.map((e) => e.value || 0));
        const width = 850 / entries.length;
        entries.forEach((entry, i) => {
            const height = (entry.value || 0) / maximum * 140;
            const bar = svgNode('rect', {x: 30 + width * i, y: 166 - height, width: Math.max(1, width - 5), height: Math.max(1, height), fill: entry.known ? '#187a7c' : '#c1cdd5'});
            bar.appendChild(svgNode('title', {}, entry.label + ': ' + (entry.known ? entry.value : 'нет наблюдения')));
            svg.appendChild(bar);
            svg.appendChild(svgNode('text', {x: 30 + width * (i + .45), y: 185, 'text-anchor': 'middle'}, entry.label));
            if (entry.known) svg.appendChild(svgNode('text', {x: 30 + width * (i + .45), y: 158 - height, 'text-anchor': 'middle'}, String(entry.value)));
        });
        box.appendChild(svg); return box;
    }

    function renderHours() {
        const day = byId('cl-stat-day').value;
        const stats = statisticsData[day];
        const values = Array.from({length: 24}, (_, i) => {
            const hour = String(i).padStart(2, '0'); const slot = stats && stats.hours[hour];
            return {label: hour, value: slot ? slot.peak : 0, known: Boolean(slot)};
        });
        byId('cl-hour-chart').textContent = '';
        byId('cl-hour-chart').appendChild(bars('Пик одновременных разговоров по часам · ' + day, values));
    }

    async function loadStatistics() {
        byId('cl-statistics-status').textContent = 'Загрузка…';
        try {
            const result = await apiRead('statistics', {from: byId('cl-statistics-from').value, to: byId('cl-statistics-to').value});
            if (result.state !== 'ready') throw new Error(result.state === 'invalid' ? 'Укажите диапазон до 31 дня.' : 'Статистика пока недоступна: обновите и проверьте сборщик.');
            statisticsData = result.days;
            const rows = Object.entries(result.days).map(([day, s]) => {
                const row = node('tr'); cell(row, day); cell(row, String(s.calls || 0) + ' / ' + String(s.answered || 0));
                cell(row, String(s.peak)); cell(row, formatDuration(Math.floor(s.longest || 0)));
                cell(row, formatDuration(Math.floor(Math.min(86400, s.observed_seconds || 0)))); return row;
            });
            table('cl-statistics', rows, 5, 'Наблюдений за выбранный период нет.');
            const select = byId('cl-stat-day'); const old = select.value; select.textContent = '';
            for (const day of Object.keys(result.days)) { const o = node('option', day); o.value = day; select.appendChild(o); }
            select.value = result.days[old] ? old : Object.keys(result.days).slice(-1)[0] || '';
            byId('cl-load-chart').textContent = '';
            byId('cl-load-chart').appendChild(bars('Пик одновременных разговоров по дням', Object.entries(result.days).map(([day, s]) => ({label: day.slice(5), value: s.peak, known: true}))));
            renderHours();
            const trunkRows = (inventory ? inventory.trunks : []).map((trunk) => {
                const key = techName(trunk.tech) + '/' + trunk.channelid;
                const peak = Math.max(0, ...Object.values(result.days).map((s) => s.endpoints[key] || 0));
                const row = node('tr'); cell(row, trunkName(trunk)); cell(row, String(peak)); return row;
            });
            table('cl-trunk-peaks', trunkRows, 2, 'Справочник транков пока не загружен.');
            byId('cl-statistics-status').textContent = 'Снимок статистики ' + dateTime(result.updated_at) + '. Данные начинают накапливаться после обновления сборщика.';
        } catch (error) { byId('cl-statistics-status').textContent = error.message; }
    }

    async function loadDiagnostics() {
        byId('cl-diagnostics-status').textContent = 'Проверка…';
        try {
            const d = await apiRead('diagnostics');
            diagnosis = d;
            const runtime = d.runtime || {}; const journal = d.journal || {};
            byId('cl-diagnostics-fields').textContent = '';
            byId('cl-diagnostics-fields').appendChild(detailFields([
                ['Модуль', d.module_version], ['Сборщик', d.collector_version || 'Версия не определена (старый сборщик или нет свежего снимка)'],
                ['Совместимость', d.compatible ? 'Версии совпадают' : 'Требуется обновление сборщика / проверка службы'],
                ['Связь с АТС', (health[d.pbx_state] || health.collector_unavailable)[0]],
                ['Последний снимок', dateTime(d.updated_at)], ['Чтение снимка / истории', (d.snapshot_readable ? 'Да' : 'Нет') + ' / ' + (d.journal_readable ? 'Да' : 'Нет')],
                ['Python', runtime.python], ['Работа сборщика', Number.isFinite(runtime.uptime_seconds) ? formatDuration(runtime.uptime_seconds) : unknown],
                ['Период замера / давность RTP', runtime.sample_interval ? runtime.sample_interval + ' / ' + runtime.media_max_age + ' с' : unknown],
                ['Хранение', journal.retention_days ? journal.retention_days + ' дней, до ' + journal.max_mb + ' МиБ архива' : unknown],
                ['Сохранение истории', journal.storage_error ? 'Ошибка записи: проверьте диск и права' : d.journal_readable ? 'Доступно' : 'Недоступно'],
                ['Пропущено по пределу хранения', String(journal.capacity_drops || 0)],
                ['Порог качества / потерь', d.thresholds.quality + '% / ' + d.thresholds.loss + '%'],
                ['Ожидание / устойчивость проблемы', d.thresholds.wait + ' / ' + d.thresholds.sustain + ' с'],
            ]));
            byId('cl-update').hidden = !d.can_manage;
            byId('cl-update-command').value = d.update_command || '';
            if (d.can_manage) for (const key of Object.keys(d.thresholds)) byId('cl-setting-' + key).value = d.thresholds[key];
            byId('cl-diagnostics-status').textContent = d.compatible ? 'Проверка завершена. ' + (health[d.pbx_state] || health.collector_unavailable)[2]
                : 'Новые функции требуют сборщик ' + d.module_version + '. Обновление доступно администратору с полными правами.';
        } catch (error) { byId('cl-diagnostics-status').textContent = error.message; }
    }

    async function saveThresholds(event) {
        event.preventDefault();
        const status = byId('cl-settings-status');
        const body = new URLSearchParams({csrf: root.dataset.csrf || ''});
        for (const key of ['quality', 'loss', 'wait', 'sustain']) body.set(key, byId('cl-setting-' + key).value);
        try {
            const response = await fetch(apiUrl('settings'), {method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
                headers: {'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}, body});
            if (response.status === 401 || response.status === 403) throw new Error('Нужны действующая сессия и полные права администратора. Обновите страницу.');
            if (!response.ok) throw new Error('Ошибка сохранения.');
            const result = await response.json();
            if (result.state !== 'ready') throw new Error('Проверьте диапазоны значений.');
            thresholds = result.thresholds; problems.clear(); status.textContent = 'Пороги сохранены для всех пользователей.';
        } catch (error) { status.textContent = error.message; }
    }

    function selectView(name) {
        currentView = name;
        for (const key of ['monitor', 'history', 'statistics', 'diagnostics']) byId('cl-view-' + key).hidden = name !== key;
        for (const button of root.querySelectorAll('[data-cl-view]')) button.setAttribute('aria-pressed', String(button.dataset.clView === name));
        if (name === 'history') loadHistory();
        if (name === 'statistics') loadStatistics();
        if (name === 'diagnostics') loadDiagnostics();
    }

    const today = localDate();
    const week = new Date(); week.setDate(week.getDate() - 6);
    byId('cl-history-from').value = today; byId('cl-history-to').value = today;
    byId('cl-statistics-from').value = localDate(week); byId('cl-statistics-to').value = today;
    if (root.querySelectorAll) for (const button of root.querySelectorAll('[data-cl-view]')) button.addEventListener('click', () => selectView(button.dataset.clView));
    byId('cl-history-form').addEventListener('submit', (event) => { event.preventDefault(); loadHistory(); });
    byId('cl-history-more').addEventListener('click', () => loadHistory(true));
    byId('cl-statistics-form').addEventListener('submit', (event) => { event.preventDefault(); loadStatistics(); });
    byId('cl-diagnostics-refresh').addEventListener('click', loadDiagnostics);
    byId('cl-chart-channel').addEventListener('change', renderQualityCharts);
    byId('cl-stat-day').addEventListener('change', renderHours);
    byId('cl-problem-filter').addEventListener('change', () => { if (snapshot) paint(snapshot); });
    byId('cl-threshold-form').addEventListener('submit', saveThresholds);
    byId('cl-copy-update').addEventListener('click', async () => {
        const field = byId('cl-update-command');
        try {
            await navigator.clipboard.writeText(field.value);
            byId('cl-settings-status').textContent = 'Команда скопирована.';
        } catch (error) {
            field.focus(); field.select();
            byId('cl-settings-status').textContent = 'Команда выделена. Нажмите Ctrl+C.';
        }
    });

    refresh();
})();
