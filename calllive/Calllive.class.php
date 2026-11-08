<?php

namespace FreePBX\modules;

class Calllive implements \BMO
{
    const SNAPSHOT = '/run/freepbx-calllive/snapshot.json';
    const MAX_BYTES = 4194304;
    const MAX_AGE = 18;

    private $freepbx;

    public function __construct($freepbx)
    {
        $this->freepbx = $freepbx;
    }

    public function install() {}
    public function uninstall() {}
    public function backup() {}
    public function restore($backup) {}
    public function doConfigPageInit($page) {}

    public function canView()
    {
        if (!isset($_SESSION['AMP_user']) || !($_SESSION['AMP_user'] instanceof \ampuser)) {
            return false;
        }
        $user = $_SESSION['AMP_user'];
        // This section grants PBX-wide read access to the monitor and its detail cards.
        if (!$user->checkSection('calllive')) {
            return false;
        }

        $timeout = (int) $this->freepbx->Config->get('SESSION_TIMEOUT');
        if ($timeout > 0 && (empty($user->_lastactivity)
            || time() - (int) $user->_lastactivity > max(60, $timeout))) {
            return false;
        }
        return $this->freepbx->Modules->checkStatus('calllive');
    }

    public function ajaxRequest($request, &$settings)
    {
        return in_array($request, array('snapshot', 'extension', 'trunk'), true) && isset($_SERVER['REQUEST_METHOD'])
            && $_SERVER['REQUEST_METHOD'] === 'GET' && $this->canView();
    }

    public function ajaxHandler()
    {
        $this->freepbx->Ajax->addHeader('Cache-Control', 'no-store, private');
        if (!$this->canView()) {
            $this->freepbx->Ajax->ajaxError(403, 'CallLive access denied');
        }

        $command = isset($_GET['command']) ? $_GET['command'] : '';
        if ($command === 'extension' || $command === 'trunk') {
            $id = isset($_GET['id']) && is_string($_GET['id']) ? $_GET['id'] : '';
            $format = $command === 'extension' ? '/\A[A-Za-z0-9*#_.+\-]{1,20}\z/' : '/\A[0-9]{1,10}\z/';
            if (!preg_match($format, $id)) {
                return array('state' => 'missing');
            }
            // Avoid holding the admin session lock while asking Asterisk for details.
            session_write_close();
            try {
                return $command === 'extension' ? $this->extensionDetail($id) : $this->trunkDetail($id);
            } catch (\Exception $error) {
                return array('state' => 'unavailable');
            }
        }

        $snapshot = $this->readSnapshot();
        if (isset($_GET['inventory']) && $_GET['inventory'] === '1') {
            try {
                $database = $this->freepbx->Database;
                $snapshot['inventory'] = array(
                    'extensions' => $database->query(
                        'SELECT `extension`, `name` FROM `users` ORDER BY `extension`'
                    )->fetchAll(\PDO::FETCH_ASSOC),
                    'devices' => $database->query(
                        'SELECT `id`, `tech`, `dial`, `user`, `devicetype` FROM `devices` ORDER BY `id`'
                    )->fetchAll(\PDO::FETCH_ASSOC),
                    'trunks' => $database->query(
                        'SELECT `trunkid`, `tech`, `channelid`, `name`, `disabled` FROM `trunks` ORDER BY `trunkid`'
                    )->fetchAll(\PDO::FETCH_ASSOC),
                );
            } catch (\Exception $error) {
                $snapshot['inventory_error'] = true;
            }
        }
        return $snapshot;
    }

    private function rows($sql, $id)
    {
        $query = $this->freepbx->Database->prepare($sql);
        $query->execute(array($id));
        return $query->fetchAll(\PDO::FETCH_ASSOC);
    }

    private function extensionDetail($id)
    {
        $rows = $this->rows('SELECT extension, name, voicemail, ringtimer, outboundcid
            FROM users WHERE extension = ? LIMIT 1', $id);
        if (!$rows) {
            return array('state' => 'missing');
        }
        $devices = $this->rows('SELECT id, tech, dial, devicetype, description
            FROM devices WHERE user = ? ORDER BY id', $id);
        $deadline = microtime(true) + 2.0;
        $features = array();
        foreach (array('DND', 'CF', 'CFB', 'CFU', 'CW') as $family) {
            $features[$family] = $this->astdb($family, $id, $deadline);
        }
        $features['followme'] = $this->astdb('AMPUSER', $id . '/followme/ddial', $deadline);
        $features['followme_list'] = $features['followme'] === 'DIRECT'
            ? $this->astdb('AMPUSER', $id . '/followme/grplist', $deadline) : null;

        foreach ($devices as &$device) {
            $device['endpoint'] = array();
            if (preg_match('~\A(PJSIP|SIP)/([A-Za-z0-9_.+\-]+)(?:/[^\s]*)?\z~i', $device['dial'], $match)) {
                $device['endpoint'] = $this->sipDetail(strtolower($match[1]), $match[2], $deadline);
            }
        }
        unset($device);
        return array('state' => 'ready', 'entry' => $rows[0], 'devices' => $devices, 'features' => $features);
    }

    private function trunkDetail($id)
    {
        $rows = $this->rows('SELECT trunkid, name, tech, channelid, disabled, outcid,
            maxchans, dialoutprefix, usercontext, provider, `continue` FROM trunks WHERE trunkid = ? LIMIT 1', $id);
        if (!$rows) {
            return array('state' => 'missing');
        }
        $trunk = $rows[0];
        $routes = $this->rows('SELECT r.name FROM outbound_route_trunks t JOIN outbound_routes r ON r.route_id = t.route_id
            WHERE t.trunk_id = ? ORDER BY r.name', $id);
        $tech = strtolower($trunk['tech']);
        $endpoint = $this->sipDetail($tech, $trunk['channelid'], microtime(true) + 1.2);
        $settings = array();
        $registration = null;
        if ($tech === 'pjsip') {
            foreach ($this->rows("SELECT keyword, data FROM pjsip WHERE id = ?
                AND keyword IN ('sip_server', 'sip_server_port', 'registration')", $id) as $item) {
                $settings[$item['keyword']] = $item['data'];
            }
            if (!isset($settings['registration']) || $settings['registration'] === 'send') {
                $result = $this->ami('PJSIPShowRegistrationsOutbound', array(), 'OutboundRegistrationDetail',
                    'OutboundRegistrationDetailComplete', microtime(true) + 0.8);
                foreach ($result['items'] as $item) {
                    if (isset($item['ObjectName'], $item['Status']) && $item['ObjectName'] === $trunk['channelid']) {
                        $registration = $item['Status'];
                        break;
                    }
                }
            }
        }
        return array('state' => 'ready', 'entry' => $trunk, 'routes' => $routes, 'settings' => $settings,
            'endpoint' => $endpoint, 'registration' => $registration);
    }

    private function astdb($family, $key, $deadline)
    {
        $result = $this->ami('DBGet', array('Family' => $family, 'Key' => $key),
            'DBGetResponse', 'DBGetComplete', $deadline);
        if (isset($result['reply']['Message']) && $result['reply']['Message'] === 'Database entry not found') {
            return '';
        }
        return isset($result['items'][0]['Val']) ? $result['items'][0]['Val'] : null;
    }

    private function sipDetail($tech, $endpoint, $deadline)
    {
        if (!preg_match('/\A[A-Za-z0-9_.+\-]{1,190}\z/', $endpoint)) {
            return array();
        }
        if ($tech === 'pjsip') {
            $result = $this->ami('PJSIPShowEndpoint', array('Endpoint' => $endpoint),
                array('EndpointDetail', 'AorDetail'), 'EndpointDetailComplete', $deadline);
            $data = array();
            $aors = array();
            foreach ($result['items'] as $item) {
                if ($item['Event'] === 'EndpointDetail') {
                    $data = $item;
                } else {
                    $addresses = array();
                    if (isset($item['Contacts'])) {
                        foreach (explode(',', $item['Contacts']) as $contact) {
                            if (preg_match('~(?:^|/)sips?:([^\s<>]+)~i', trim($contact), $match)) {
                                $address = preg_replace('/^.*@/', '', $match[1]);
                                if (preg_match('/\A(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:[0-9]{1,5})?(?:[;?]|$)/i', $address, $host)) {
                                    $addresses[] = $host[1] . (isset($host[2]) ? $host[2] : '');
                                }
                            }
                        }
                    }
                    $aors[] = array('name' => isset($item['ObjectName']) ? $item['ObjectName'] : '',
                        'contacts' => array_values(array_unique($addresses)),
                        'registered' => isset($item['ContactsRegistered']) ? $item['ContactsRegistered'] : null,
                        'qualify' => isset($item['QualifyFrequency']) ? $item['QualifyFrequency'] : null);
                }
            }
            $fields = array('state' => 'DeviceState', 'transport' => 'Transport',
                'codecs' => 'Allow', 'context' => 'Context', 'aors' => 'Aors', 'direct_media' => 'DirectMedia',
                'dtmf' => 'DtmfMode', 'encryption' => 'MediaEncryption');
        } elseif ($tech === 'sip') {
            $result = $this->ami('SIPshowpeer', array('Peer' => $endpoint), '', '', $deadline);
            $data = isset($result['reply']['Response']) && $result['reply']['Response'] === 'Success'
                ? $result['reply'] : array();
            $fields = array('state' => 'Status', 'ip' => 'Address-IP', 'port' => 'Address-Port', 'codecs' => 'Codecs',
                'context' => 'Context', 'agent' => 'SIP-Useragent', 'direct_media' => 'SIP-DirectMedia',
                'dtmf' => 'SIP-DTMFmode', 'encryption' => 'SIP-Encryption');
        } else {
            return array();
        }
        $detail = array();
        foreach ($fields as $key => $field) {
            if (isset($data[$field]) && $data[$field] !== '') {
                $detail[$key] = $data[$field];
            }
        }
        if (!empty($aors)) {
            $detail['aor_details'] = $aors;
        }
        return $detail;
    }

    private function ami($action, array $headers, $item, $complete, $deadline)
    {
        $result = array('reply' => array(), 'items' => array());
        $astman = $this->freepbx->astman;
        if (!$astman || !$astman->connected() || microtime(true) >= $deadline) {
            return $result;
        }
        // Only fixed actions and validated arguments reach this AMI connection.
        $id = uniqid('calllive-', true);
        $message = "Action: $action\r\nActionID: $id\r\n";
        foreach ($headers as $name => $value) {
            $message .= "$name: $value\r\n";
        }
        $message .= "\r\n";
        if (fwrite($astman->socket, $message) !== strlen($message)) {
            return $result;
        }
        try {
            while (($remaining = $deadline - microtime(true)) > 0) {
                $micros = (int) ($remaining * 1000000);
                stream_set_timeout($astman->socket, (int) ($micros / 1000000), $micros % 1000000);
                $packet = $astman->wait_response(true, true);
                if (!$packet) {
                    break;
                }
                if (!isset($packet['ActionID']) || $packet['ActionID'] !== $id) {
                    continue;
                }
                if (isset($packet['Response'])) {
                    $result['reply'] = $packet;
                    if (!$complete || $packet['Response'] !== 'Success') {
                        break;
                    }
                } elseif (isset($packet['Event'])) {
                    if ($packet['Event'] === $complete) {
                        break;
                    }
                    if (in_array($packet['Event'], (array) $item, true)) {
                        $result['items'][] = $packet;
                    }
                }
            }
        } finally {
            if (is_resource($astman->socket)) {
                stream_set_timeout($astman->socket, 30);
            }
        }
        return $result;
    }

    private function readSnapshot()
    {
        $body = is_readable(self::SNAPSHOT)
            ? @file_get_contents(self::SNAPSHOT, false, null, 0, self::MAX_BYTES + 1) : false;
        $snapshot = is_string($body) && strlen($body) <= self::MAX_BYTES ? json_decode($body, true) : null;
        if (!is_array($snapshot) || !isset($snapshot['schema'], $snapshot['state'], $snapshot['updated_at'])
            || $snapshot['schema'] !== 1 || !is_int($snapshot['updated_at'])
            || abs(time() - $snapshot['updated_at']) > self::MAX_AGE) {
            return array('state' => 'collector_unavailable');
        }
        if ($snapshot['state'] !== 'ready') {
            return array('state' => $snapshot['state'], 'daily' => isset($snapshot['daily']) ? $snapshot['daily'] : null);
        }
        if (!isset($snapshot['channels'], $snapshot['groups'], $snapshot['hints'])
            || !is_array($snapshot['channels']) || !is_array($snapshot['groups']) || !is_array($snapshot['hints'])) {
            return array('state' => 'collector_unavailable');
        }
        return $snapshot;
    }
}
