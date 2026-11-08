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
<div id="calllive">
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

    <dl class="cl-metrics">
        <div><dt>Активные соединения</dt><dd id="cl-count-connections">—</dd></div>
        <div><dt>Занятые транки</dt><dd id="cl-count-trunks">—</dd></div>
        <div><dt>Номера с активностью</dt><dd id="cl-count-extensions">—</dd></div>
    </dl>

    <section class="cl-section" aria-labelledby="cl-calls-title">
        <div class="cl-section-title">
            <h2 id="cl-calls-title" tabindex="-1">Текущие вызовы</h2>
            <span>Нажмите на активный разговор, чтобы открыть детали</span>
        </div>
        <div class="cl-table-wrap">
            <table class="cl-table">
                <thead><tr><th scope="col">Статус</th><th scope="col">Участники / каналы</th><th scope="col">Транки</th><th scope="col">Качество</th><th scope="col">С начала вызова</th></tr></thead>
                <tbody id="cl-calls"><tr><td colspan="5">Ожидание данных…</td></tr></tbody>
            </table>
        </div>
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
