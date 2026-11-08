<?php

if (!defined('FREEPBX_IS_AUTH')) {
    http_response_code(403);
    exit;
}
if (!\FreePBX::Calllive()->canView()) {
    echo '<div class="alert alert-warning">Для просмотра разрешите пользователю раздел «Монитор телефонии» в настройках доступа FreePBX.</div>';
    return;
}
?>
<div id="calllive" data-csrf="<?php echo htmlspecialchars(\FreePBX::Calllive()->csrfToken(), ENT_QUOTES, 'UTF-8'); ?>">
    <header class="cl-header">
        <div class="cl-heading">
            <div class="cl-kicker">FREEPBX · ASTERISK</div>
            <h1>Монитор телефонии</h1>
            <p>Соединения, транки и состояния внутренних номеров</p>
        </div>
        <div class="cl-daily">
            <p id="cl-daily-date">За сутки по времени АТС</p>
            <dl>
                <div><dt>Максимум одновременных разговоров</dt><dd id="cl-daily-peak">—</dd></div>
                <div><dt>Самый длинный разговор</dt><dd id="cl-daily-longest">—</dd></div>
            </dl>
        </div>
        <div class="cl-health">
            <span id="cl-status" class="cl-badge" data-tone="neutral" role="status">Подключение…</span>
            <span id="cl-updated"></span>
        </div>
    </header>

    <p id="cl-notice" class="cl-notice" hidden></p>
    <noscript><p class="cl-notice">Для обновления панели включите JavaScript.</p></noscript>

    <nav class="cl-tabs" aria-label="Разделы монитора">
        <button type="button" data-cl-view="monitor" aria-pressed="true">Сейчас</button>
        <button type="button" data-cl-view="history" aria-pressed="false">История</button>
        <button type="button" data-cl-view="statistics" aria-pressed="false">Статистика</button>
        <button type="button" data-cl-view="diagnostics" aria-pressed="false">Диагностика и обновление</button>
    </nav>
    <div id="cl-view-monitor">
    <dl class="cl-metrics">
        <div><dt>Активные соединения</dt><dd id="cl-count-connections">—</dd></div>
        <div><dt>Занятые транки</dt><dd id="cl-count-trunks">—</dd></div>
        <div><dt>Номера с активностью</dt><dd id="cl-count-extensions">—</dd></div>
    </dl>

    <section class="cl-section" aria-labelledby="cl-calls-title">
        <div class="cl-section-title">
            <h2 id="cl-calls-title" tabindex="-1">Текущие вызовы</h2>
            <label class="cl-search">Показать
                <select id="cl-problem-filter"><option value="all">Все вызовы</option><option value="problems">Все проблемы</option>
                    <option value="quality">Низкое качество</option><option value="loss">Потери пакетов</option><option value="wait">Долгое ожидание</option></select>
            </label>
        </div>
        <p id="cl-alerts" class="cl-alerts" role="status" hidden></p>
        <div class="cl-table-wrap">
            <table class="cl-table">
                <thead><tr><th scope="col">Статус</th><th scope="col">Участники / каналы</th><th scope="col">Транки</th><th scope="col">Качество</th><th scope="col">С начала вызова</th></tr></thead>
                <tbody id="cl-calls"><tr><td colspan="5">Ожидание данных…</td></tr></tbody>
            </table>
        </div>
    </section>

    <div class="cl-columns">
        <section class="cl-section" aria-labelledby="cl-trunks-title">
            <div class="cl-section-title">
                <h2 id="cl-trunks-title" tabindex="-1">Транки</h2>
                <span>Нажмите на транк, чтобы открыть сведения</span>
            </div>
            <div class="cl-table-wrap">
                <table class="cl-table">
                    <thead><tr><th scope="col">Имя</th><th scope="col">Статус</th><th scope="col">Каналов</th></tr></thead>
                    <tbody id="cl-trunks"><tr><td colspan="3">Ожидание данных…</td></tr></tbody>
                </table>
            </div>
        </section>

        <section class="cl-section" aria-labelledby="cl-extensions-title">
            <div class="cl-section-title">
                <h2 id="cl-extensions-title" tabindex="-1">Внутренние номера</h2>
                <label class="cl-search"><span class="sr-only">Найти номер или имя</span>
                    <input id="cl-search" type="search" placeholder="Номер или имя" autocomplete="off">
                </label>
            </div>
            <div class="cl-table-wrap">
                <table class="cl-table">
                    <thead><tr><th scope="col">Номер / имя</th><th scope="col">Состояние</th><th scope="col">Каналов</th></tr></thead>
                    <tbody id="cl-extensions"><tr><td colspan="3">Ожидание данных…</td></tr></tbody>
                </table>
            </div>
        </section>
    </div>
    <p class="cl-footnote">Статус «Снята трубка» появляется, когда АТС получает сигнал OffHook. IP-телефон может оставаться в статусе «Свободен» до передачи SIP-сигнала.</p>
    </div>
    <section id="cl-view-history" class="cl-section" hidden aria-labelledby="cl-history-title">
        <div class="cl-section-title"><h2 id="cl-history-title" tabindex="-1">История вызовов</h2></div>
        <form id="cl-history-form" class="cl-toolbar">
            <label>С <input id="cl-history-from" type="date" required></label>
            <label>По <input id="cl-history-to" type="date" required></label>
            <label>Номер или канал <input id="cl-history-search" type="search" maxlength="100" placeholder="201, +7…, PJSIP/carrier"></label>
            <label><input id="cl-history-problem" type="checkbox"> С низким качеством</label>
            <button class="cl-detail-link" type="submit">Найти</button>
        </form>
        <p id="cl-history-status" class="cl-view-note" role="status">История накапливается после обновления сборщика. Даты поиска — по времени АТС; часы событий — по времени браузера.</p>
        <div class="cl-table-wrap"><table class="cl-table">
            <thead><tr><th>Начало / завершение</th><th>Участники / каналы</th><th>Разговор / весь вызов</th><th>Качество: последнее / худшее</th><th>Результат</th></tr></thead>
            <tbody id="cl-history"></tbody>
        </table></div>
        <button id="cl-history-more" type="button" class="cl-detail-link cl-more" hidden>Ещё вызовы</button>
    </section>

    <section id="cl-view-statistics" class="cl-section" hidden aria-labelledby="cl-statistics-title">
        <div class="cl-section-title"><h2 id="cl-statistics-title">Статистика за несколько дней</h2></div>
        <form id="cl-statistics-form" class="cl-toolbar">
            <label>С <input id="cl-statistics-from" type="date" required></label>
            <label>По <input id="cl-statistics-to" type="date" required></label>
            <button class="cl-detail-link" type="submit">Показать</button>
        </form>
        <p id="cl-statistics-status" class="cl-view-note" role="status"></p>
        <div id="cl-load-chart" class="cl-stat-chart"></div>
        <div class="cl-table-wrap"><table class="cl-table">
            <thead><tr><th>Дата</th><th>Завершено / с ответом</th><th>Пик разговоров</th><th>Самый длинный за сутки</th><th>Наблюдение</th></tr></thead>
            <tbody id="cl-statistics"></tbody>
        </table></div>
        <h3 class="cl-view-note">Загрузка по часам выбранного дня</h3>
        <label class="cl-search cl-view-note">День <select id="cl-stat-day"></select></label>
        <div id="cl-hour-chart" class="cl-stat-chart"></div>
        <h3 class="cl-view-note">Максимум одновременно используемых каналов каждого транка</h3>
        <div class="cl-table-wrap"><table class="cl-table"><thead><tr><th>Транк</th><th>Пик каналов за период</th></tr></thead><tbody id="cl-trunk-peaks"></tbody></table></div>
        <p class="cl-view-note">Счётчики вызовов относятся к завершённым наблюдаемым вызовам по дню начала. Пики и часы показывают период работы сборщика; отсутствие наблюдения обозначается отдельно.</p>
    </section>

    <section id="cl-view-diagnostics" class="cl-section" hidden aria-labelledby="cl-diagnostics-title">
        <div class="cl-section-title"><h2 id="cl-diagnostics-title">Диагностика и обновление</h2>
            <button id="cl-diagnostics-refresh" type="button" class="cl-detail-link">Проверить</button></div>
        <p id="cl-diagnostics-status" class="cl-view-note" role="status"></p>
        <div id="cl-diagnostics-fields" class="cl-view-note"></div>
        <div id="cl-update" class="cl-update" hidden>
            <h3>Упрощённое обновление</h3>
            <p>Загрузите новый архив CallLive в Module Admin, выполните Upgrade и Apply Config. Затем скопируйте команду ниже и выполните от root на АТС.</p>
            <label class="sr-only" for="cl-update-command">Команда обновления сборщика</label>
            <textarea id="cl-update-command" rows="2" readonly spellcheck="false"></textarea>
            <button id="cl-copy-update" type="button" class="cl-detail-link">Копировать команду</button>
            <p class="cl-detail-note">Команда проверяет Python и AMI, сохраняет резервную копию, обновляет сборщик и проверяет свежий снимок. При ошибке возвращает предыдущие файлы. После обновления примените локальную подпись командой из релиза.</p>
            <p><a href="https://github.com/shayena84-byte/freepbx-calllive/releases/latest" target="_blank" rel="noopener noreferrer">Открыть последний релиз в закрытом репозитории</a></p>
            <h3>Пороги уведомлений</h3>
            <form id="cl-threshold-form" class="cl-toolbar">
                <label>Качество ниже, % <input id="cl-setting-quality" type="number" min="0" max="100" step="1" required></label>
                <label>Потери выше, % <input id="cl-setting-loss" type="number" min="0.1" max="100" step="0.1" required></label>
                <label>Ожидание дольше, с <input id="cl-setting-wait" type="number" min="5" max="3600" required></label>
                <label>Проблема держится, с <input id="cl-setting-sustain" type="number" min="0" max="300" required></label>
                <button type="submit" class="cl-detail-link">Сохранить</button>
            </form>
            <p id="cl-settings-status" class="cl-detail-note" role="status"></p>
        </div>
        <p class="cl-view-note">Уведомления отображаются в открытой панели. Пороги общие для пользователей; изменяет администратор с полными правами.</p>
    </section>

    <dialog id="cl-detail" class="cl-detail" aria-labelledby="cl-detail-title">
        <div class="cl-section-title">
            <h2 id="cl-detail-title">Технические детали разговора</h2>
            <form method="dialog">
                <button type="submit" class="cl-detail-close" autofocus>Закрыть</button>
            </form>
        </div>
        <div class="cl-detail-summary">
            <span id="cl-detail-state" role="status"></span>
            <span id="cl-detail-age" class="cl-time"></span>
            <span id="cl-detail-quality"></span>
        </div>
        <section id="cl-insights" class="cl-insights" hidden>
            <p id="cl-record-summary" class="cl-detail-note"></p>
            <h3>Как рассчитано качество</h3>
            <div id="cl-quality-explanation"></div>
            <label class="cl-search">Графики по каналу <select id="cl-chart-channel"><option value="">Худшие измерения всех каналов</option></select></label>
            <div id="cl-quality-charts" class="cl-chart-grid"></div>
            <p id="cl-chart-note" class="cl-detail-note"></p>
            <h3>События разговора</h3>
            <ol id="cl-timeline" class="cl-timeline"></ol>
            <p id="cl-record-notice" class="cl-detail-note" role="status"></p>
        </section>
        <div id="cl-detail-legs" class="cl-detail-legs"></div>
    </dialog>

    <dialog id="cl-entity" class="cl-detail" aria-labelledby="cl-entity-title">
        <div class="cl-section-title">
            <h2 id="cl-entity-title">Сведения</h2>
            <form method="dialog">
                <button type="submit" class="cl-detail-close" autofocus>Закрыть</button>
            </form>
        </div>
        <div class="cl-detail-summary">
            <span id="cl-entity-live"></span>
            <span id="cl-entity-status" role="status"></span>
        </div>
        <div id="cl-entity-legs" class="cl-detail-legs"></div>
    </dialog>


</div>
