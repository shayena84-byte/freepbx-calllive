<?php
/**
 * Локальная подпись CallLive 15.0.9 для FreePBX 15.
 * Запуск на АТС от root: php /root/calllive-15.0.9-sign-local.php
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
if (!function_exists('posix_geteuid') || posix_geteuid() !== 0) {
    fwrite(STDERR, "Запустите скрипт в консоли АТС от root.\n");
    exit(1);
}

// SHA-256 файлов из опубликованного архива CallLive 15.0.9.
$expected = array(
    'Calllive.class.php' => '1c2be3f21460f152445e8049e4e810ebdcce2981ad8cff1ec6f487589bd30256',
    'LICENSE' => '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
    'README_RU.md' => '305fe349ef8c252cc4faee9f8c5e82338ed65f23b3f84e03cbdea072a9d151c3',
    'assets/css/calllive.css' => '4ec3eb69c839f9e86d90d16131695af6100292b5e944364cc0cbb54ecf1292eb',
    'assets/js/calllive.js' => 'd09c77674165b48a69e822540611dafb84e6a41804525effaa0737050c73cd89',
    'deploy/collector.py' => '7a783a6d34a071bb8d07dd016916a3f79161716acf77a0b293597612d291b454',
    'deploy/files.sha256' => '2e902ce13f58e31491cc8091ccc44221927e13717fd0b58fc8992f6f18c0edd7',
    'deploy/freepbx-calllive.service' => '240a113d216d8fa079b23c77eebca8bc81264f693df4075c649caffa1e7a2f28',
    'deploy/release.json' => 'a4a4de61a46ecd6a112e7b8ed520606a32c7f445671b8cb3b45175ed1c45896d',
    'deploy/telemetry.py' => 'd4535e9234b7c9799a8ec61dc5f8be78d30aa7272ad4491dfef799d1de1e3a1b',
    'deploy/update-root.sh' => '100a18836f47ce59557c18daf0de92d030acf640f6ad08a22a71df4e3ae6e426',
    'module.xml' => 'ce1bbe7799071239af8444d0e2161980539ee3f0960597cf16ce97bc6697b217',
    'page.calllive.php' => '23ef2281948472c3dcc754de119c5ff1ad8a4e69aea6e97d27c19578bbfe82ef',
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
        throw new RuntimeException('Установите CallLive 15.0.9 через управление модулями.');
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
            throw new RuntimeException('Файл отсутствует или отличается от CallLive 15.0.9: ' . $name);
        }
    }
    $extras = array_diff_key($actual, $expected);
    if ($extras) {
        throw new RuntimeException('Обнаружены дополнительные файлы модуля: ' . implode(', ', array_keys($extras)));
    }
    echo "Файлы CallLive 15.0.9 совпали с опубликованным архивом.\n";

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
