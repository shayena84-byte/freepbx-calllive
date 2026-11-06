<?php
/**
 * Локальная подпись CallLive 15.0.6 для FreePBX 15.
 * Запуск на АТС от root: php /root/calllive-15.0.6-sign-local.php
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
if (!function_exists('posix_geteuid') || posix_geteuid() !== 0) {
    fwrite(STDERR, "Запустите скрипт в консоли АТС от root.\n");
    exit(1);
}

// SHA-256 файлов из опубликованного архива CallLive 15.0.6.
$expected = array(
    'Calllive.class.php' => 'd9a0f6cce1c6f5e778ac8669c637ef0c004c4a6cc9fa4fcedb907b3ba86900d8',
    'LICENSE' => '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
    'README_RU.md' => '83f78a12b00f630dd916a5d46df69fb3e45eb277ff34bdc5b3faa923ead7c650',
    'assets/css/calllive.css' => '43fd1d289f2e29c9da80291d7da55a926decaf6e6e502ebc0d6c85e7d9230131',
    'assets/js/calllive.js' => '589301218c81bfc995a4155f47dc6dac6f5b175f7792308550d3086a1352d435',
    'deploy/collector.py' => '845f8bb05e21fc4f5f5456c29ee0e25d5654c19f66a097c3b0b7bc2e66cc9765',
    'deploy/freepbx-calllive.service' => 'ece0748cc76d282288f6cccbb7b90921b4f3231ffda1ec25cc1027fa01e0cf68',
    'module.xml' => 'e623796c319fbad5ee628e4ee026a5e939664485a0c4c947781d614af95f0f78',
    'page.calllive.php' => '9401ccc300d285de40ff67c54175e459ca36ee85013bf4124351e4c3df66b684',
);

function clSignCommand(array $args, $input = '')
{
    $command = implode(' ', array_map('escapeshellarg', $args));
    $fds = array(array('pipe', 'r'), array('pipe', 'w'), STDERR);
    $process = proc_open($command, $fds, $pipes);
    if (!is_resource($process)) {
        throw new RuntimeException('Не удалось запустить ' . $args[0]);
    }
    $written = $input === '' ? 0 : fwrite($pipes[0], $input);
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    if (proc_close($process) !== 0 || $written !== strlen($input) || $output === false) {
        throw new RuntimeException('Команда завершилась с ошибкой: ' . $args[0]);
    }
    return $output;
}

function clSignDirectory($path, $mode)
{
    if (!file_exists($path) && !is_link($path)) {
        if (!mkdir($path, $mode) || !chmod($path, $mode)) {
            throw new RuntimeException('Не удалось создать ' . $path);
        }
    }
    if (is_link($path) || !is_dir($path) || fileowner($path) !== 0 || (fileperms($path) & 0022) !== 0) {
        throw new RuntimeException('Ожидается каталог root без права записи для группы и остальных: ' . $path);
    }
}

function clSignManifest($key, $repo, array $hashes)
{
    $manifest = "[config]\nversion=2\nhash=sha256\nsignedwith=$key\nsignedby=CallLive\nrepo=$repo\ntype=local\n[hashes]\n";
    foreach ($hashes as $file => $digest) {
        $manifest .= "$file = $digest\n";
    }
    return $manifest;
}

function clSignAtomicWrite($file, $content)
{
    // Создаём файл с правами 0644 и заменяем подпись одним переименованием.
    $temp = dirname($file) . '/.calllive-sign-' . bin2hex(openssl_random_pseudo_bytes(16));
    $mask = umask(0022);
    try {
        $handle = fopen($temp, 'xb');
    } finally {
        umask($mask);
    }
    if ($handle === false) {
        throw new RuntimeException('Не удалось подготовить ' . $file);
    }
    try {
        if (fwrite($handle, $content) !== strlen($content) || !fflush($handle) || !rename($temp, $file)) {
            throw new RuntimeException('Не удалось записать ' . $file);
        }
    } finally {
        fclose($handle);
        if (is_file($temp)) {
            unlink($temp);
        }
    }
}

try {
    if (!is_readable('/etc/freepbx.conf')) {
        throw new RuntimeException('Файл /etc/freepbx.conf недоступен. Запустите скрипт на сервере FreePBX.');
    }
    $bootstrap_settings = array('freepbx_auth' => false, 'skip_astman' => true);
    require_once '/etc/freepbx.conf';
    if (!version_compare(getVersion(), '15.0', '>=') || version_compare(getVersion(), '16.0', '>=')) {
        throw new RuntimeException('Этот скрипт рассчитан на FreePBX 15.');
    }
    $config = FreePBX::Config();
    $moduleDir = rtrim($config->get('AMPWEBROOT'), '/') . '/admin/modules/calllive';
    if (is_link($moduleDir) || !is_dir($moduleDir)) {
        throw new RuntimeException('Установите CallLive 15.0.6 через управление модулями.');
    }
    $actual = array();
    $entries = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($moduleDir, FilesystemIterator::SKIP_DOTS));
    foreach ($entries as $entry) {
        $name = substr($entry->getPathname(), strlen($moduleDir) + 1);
        if ($entry->isLink() || !$entry->isFile()) {
            throw new RuntimeException('Ожидается обычный файл: ' . $name);
        }
        if ($name !== 'module.sig') {
            $actual[$name] = hash_file('sha256', $entry->getPathname());
        }
    }
    foreach ($expected as $name => $digest) {
        if (!isset($actual[$name]) || $actual[$name] !== $digest) {
            throw new RuntimeException('Файл отсутствует или отличается от CallLive 15.0.6: ' . $name);
        }
    }
    $extras = array_diff_key($actual, $expected);
    if ($extras) {
        throw new RuntimeException('Обнаружены дополнительные файлы модуля: ' . implode(', ', array_keys($extras)));
    }
    echo "Файлы CallLive 15.0.6 совпали с опубликованным архивом.\n";

    $secure = '/etc/freepbx.secure';
    clSignDirectory($secure, 0755);
    $lock = fopen($secure . '/.calllive-sign.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
        throw new RuntimeException('Подписание CallLive уже запущено.');
    }
    $keyDir = $secure . '/calllive-key';
    clSignDirectory($keyDir, 0700);
    if ((fileperms($keyDir) & 0077) !== 0) {
        throw new RuntimeException('Закрытый ключ должен быть доступен только root: ' . $keyDir);
    }

    $gpg = is_executable('/usr/bin/gpg') ? '/usr/bin/gpg' : '/usr/bin/gpg2';
    $signer = array($gpg, '--no-options', '--homedir', $keyDir, '--batch', '--no-tty');
    $listKeys = array_merge($signer, array('--with-colons', '--fingerprint', '--list-secret-keys'));
    $keys = clSignCommand($listKeys);
    if (!preg_match('/^sec:/m', $keys)) {
        clSignCommand(array_merge($signer, array('--gen-key')), "%no-protection\nKey-Type: RSA\nKey-Length: 3072\nKey-Usage: sign\nName-Real: CallLive Local Module Signing\nExpire-Date: 0\n%commit\n");
        $keys = clSignCommand($listKeys);
    }
    if (!preg_match('/^fpr:::::::::([A-F0-9]{40}):$/m', $keys, $fingerprint)) {
        throw new RuntimeException('Не найден отпечаток ключа CallLive.');
    }
    $key = $fingerprint[1];
    $sign = array_merge($signer, array('--local-user', $key, '--digest-algo', 'SHA256', '--output', '-', '--clearsign'));
    $inner = clSignCommand($sign, clSignManifest(substr($key, -16), 'manual', $expected));
    $outer = clSignCommand($sign, clSignManifest(substr($key, -16), 'local', array('calllive.sig' => hash('sha256', $inner))));

    $verifier = FreePBX::GPG();
    $webuser = $config->get('AMPASTERISKWEBUSER');
    $web = posix_getpwnam($webuser);
    $ring = $verifier->getGpgLocation();
    if (!$web || is_link($ring)) {
        throw new RuntimeException('Не удалось определить каталог GPG веб-пользователя FreePBX.');
    }
    if (fileowner($ring) === 0 && count(scandir($ring)) === 2) {
        if (!chmod($ring, 0700) || !chgrp($ring, $web['gid']) || !chown($ring, $web['uid'])) {
            throw new RuntimeException('Не удалось подготовить каталог GPG FreePBX: ' . $ring);
        }
        clearstatcache(true, $ring);
    }
    if (fileowner($ring) !== $web['uid']) {
        throw new RuntimeException('Проверьте владельца каталога GPG FreePBX: ' . $ring);
    }
    $public = clSignCommand(array_merge($signer, array('--export', $key)));
    $asWebUser = $web['uid'] === 0 ? array() : array('/usr/sbin/runuser', '-u', $webuser, '--');
    clSignCommand(array_merge($asWebUser, array($gpg, '--no-options', '--homedir', $ring, '--batch', '--import')), $public);

    $targets = array($secure . '/calllive.sig' => $inner, $moduleDir . '/module.sig' => $outer);
    $previous = array();
    foreach ($targets as $file => $content) {
        if (is_link($file) || (file_exists($file) && (!is_file($file)
            || ($file === $secure . '/calllive.sig' && fileowner($file) !== 0)))) {
            throw new RuntimeException('Проверьте тип и владельца файла подписи: ' . $file);
        }
        $previous[$file] = file_exists($file) ? file_get_contents($file) : null;
        if ($previous[$file] === false) {
            throw new RuntimeException('Не удалось прочитать прежнюю подпись: ' . $file);
        }
    }

    $written = array();
    try {
        foreach ($targets as $file => $content) {
            clSignAtomicWrite($file, $content);
            $written[] = $file;
            clSignCommand(array_merge($asWebUser, array('/usr/bin/test', '-r', $file)));
        }
        $modules = module_functions::create();
        $result = $modules->updateSignature('calllive');
        if ($result['status'] !== (FreePBX\GPG::STATE_GOOD | FreePBX\GPG::STATE_TRUSTED)) {
            $details = isset($result['details']) ? ' ' . implode(' ', $result['details']) : '';
            throw new RuntimeException('FreePBX не принял подпись.' . $details);
        }
    } catch (Exception $error) {
        foreach (array_reverse($written) as $file) {
            if ($previous[$file] === null) {
                unlink($file);
            } else {
                clSignAtomicWrite($file, $previous[$file]);
            }
        }
        if (isset($modules)) {
            $modules->updateSignature('calllive');
        }
        throw $error;
    }
    echo "Локальная подпись CallLive действительна.\n";
    echo "Отпечаток ключа: $key\n";
} catch (Exception $error) {
    fwrite(STDERR, $error->getMessage() . "\n");
    exit(1);
}
