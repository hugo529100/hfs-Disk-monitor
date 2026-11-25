exports.version = 3.0
exports.apiRequired = 12.3
exports.description = "NAS-optimized drive monitor. Passive mode subscribes to Windows event log; aggressive mode polls drive letters."
exports.repo = "hugo529100/hfs-Disk-monitor"

const { spawn } = require('child_process')

exports.config = {
    enabled: {
        type: 'boolean',
        label: 'Enable monitoring',
        defaultValue: true
    },
    monitorMode: {
        type: 'select',
        label: 'Monitor mode',
        helperText: 'Passive: subscribe to Windows event log (recommended, does not wake HDDs). Aggressive: poll drive letters (may wake HDDs).',
        // HFS select options are { label: value }: label first, stored value second.
        options: {
            'Passive (Event Log)': 'passive',
            'Aggressive (Polling)': 'aggressive'
        },
        defaultValue: 'passive'
    },
    drives: {
        type: 'multiselect',
        label: 'Drives to monitor',
        helperText: 'Select drive letters to monitor (aggressive mode only)',
        options: {
            "D:": "D:", "E:": "E:", "F:": "F:", "G:": "G:", "H:": "H:",
            "I:": "I:", "J:": "J:", "K:": "K:", "L:": "L:", "M:": "M:",
            "N:": "N:", "O:": "O:", "P:": "P:", "Q:": "Q:", "R:": "R:",
            "S:": "S:", "T:": "T:", "U:": "U:", "V:": "V:", "W:": "W:",
            "X:": "X:", "Y:": "Y:", "Z:": "Z:"
        },
        defaultValue: []
    },
    interval: {
        type: 'number',
        label: 'Check interval (seconds)',
        helperText: 'Only used in aggressive mode. Lower values increase disk wake-up frequency.',
        min: 2,
        defaultValue: 2
    }
}

exports.init = api => {

    const fs = api.require('fs')

    let timer
    let psProcess = null
    let state = new Map()

    // Older configs stored the option's description ("Passive (Event Log)") instead of
    // its value, and the old check silently fell through to the polling branch: every
    // few seconds the plugin probed every configured drive letter, which can wake all
    // HDDs. Anything that does not say "aggressive" is treated as passive from now on,
    // and the stored value is migrated once so the admin panel shows the right choice.
    function normalizeMode(value) {
        return /aggressive/i.test(String(value ?? '')) ? 'aggressive' : 'passive'
    }

    try {
        const stored = api.getConfig('monitorMode')
        if (stored !== undefined && stored !== normalizeMode(stored))
            api.setConfig('monitorMode', normalizeMode(stored))
    } catch (e) { /* ignore */ }

    // ---------- Aggressive mode: polling ----------

    function checkDrives() {

        if (!api.getConfig('enabled'))
            return

        const drives = api.getConfig('drives') || []
        if (!drives.length)
            return

        for (const drive of drives) {

            const exists = fs.existsSync(drive + '\\')
            const previous = state.get(drive)

            if (previous === undefined) {
                state.set(drive, exists)
                continue
            }

            if (previous && !exists) {
                api.log('[DiskMonitor] DRIVE OFFLINE:', drive)
            }

            state.set(drive, exists)
        }
    }

    // ---------- Passive mode: Windows event log subscription ----------

    // Fixed categories: disk errors and drive removal/offline.
    // Event IDs:
    //   error  : 7 (bad block), 55 (file system corruption),
    //            129 (reset/timeout), 153 (I/O retried)
    //   removal: 157 (surprise removed), 225/226 (Kernel-PnP device removal)
    const ERROR_IDS = [7, 55, 129, 153]
    const REMOVAL_IDS = [157, 225, 226]

    function categorize(event) {
        const src = event.Source || ''
        const id = event.Id

        if (ERROR_IDS.includes(id))
            return 'error'
        if (REMOVAL_IDS.includes(id) || src === 'Microsoft-Windows-Kernel-PnP')
            return 'removal'
        return null
    }

    // Console policy: the plugin's own labels are English, but the event text is printed
    // in whatever language Windows produced. There is no reliable machine translation for
    // arbitrary event strings, so a Chinese message stays Chinese instead of being dropped
    // or replaced by "?". Whitespace inside the Windows text is collapsed so one event
    // stays on one line; the pipe carries UTF-8 (see the encoding note further down), so
    // Chinese characters arrive intact.
    function oneLine(value) {
        return String(value ?? '').replace(/\s+/g, ' ').trim()
    }

    function cleanList(value) {
        const list = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value])
        return list.map(oneLine).filter(Boolean)
    }

    function formatMessage(raw) {
        const text = oneLine(raw)
        return text.length > 800 ? text.slice(0, 800) + '...' : text
    }

    function describeVolume(event, volumeLetters) {
        if (volumeLetters.length) {
            const fs = oneLine(event.VolumeFS)
            let text = 'volume ' + volumeLetters.join(',')
            if (fs)
                text += ' (' + fs + ')'
            const label = oneLine(event.VolumeLabel)
            if (label)
                text += ' label "' + label + '"'
            return text
        }
        if (event.VolumeGuid)
            return 'volume {' + oneLine(event.VolumeGuid) + '}'
        return 'a volume'
    }

    function describe(event, volumeLetters) {
        const dev = oneLine(event.Device)
        const lba = oneLine(event.Lba)

        switch (Number(event.Id)) {
            case 7:
                return 'bad block detected' + (dev ? ' on ' + dev : '')
            case 55:
                return 'file system structure is corrupt on ' + describeVolume(event, volumeLetters)
            case 129:
                return 'device reset issued' + (dev ? ' for ' + dev : '')
            case 153:
                return 'I/O operation retried'
                    + (lba ? ' at LBA ' + lba : '')
                    + (dev ? ' (PDO ' + dev + ')' : '')
            case 157:
                return 'disk surprise-removed' + (dev ? ': ' + dev : '')
            case 225:
            case 226:
                return 'device removal (Kernel-PnP)' + (dev ? ': ' + dev : '')
            default:
                return 'disk event'
        }
    }

    function formatEvent(category, event) {
        const level = Number(event.LevelNum)
        const severity = level === 1 ? 'CRITICAL'
            : level === 3 ? 'WARNING'
                : level === 2 ? 'ERROR'
                    : ((event.Id === 7 || event.Id === 55) ? 'ERROR' : 'WARNING')

        const diskLetters = cleanList(event.Letters)
        const volumeLetters = cleanList(event.VolumeLetters)
        // The drive letter is the first thing an admin looks for, so fall back from the
        // physical disk's letters to the volume's: event 55 names a volume, not a disk.
        const driveLetters = diskLetters.length ? diskLetters : volumeLetters

        const parts = ['[DiskMonitor] ' + severity]
        parts.push('drive=' + (driveLetters.length ? driveLetters.join(',') : 'n/a'))
        let disk = 'disk=' + (event.Disk == null ? 'n/a' : event.Disk)
        if (event.Model)
            disk += ' model="' + oneLine(event.Model) + '"'
        if (event.Serial)
            disk += ' serial=' + oneLine(event.Serial)
        if (event.SizeGB)
            disk += ' size=' + Number(event.SizeGB) + 'GB'
        parts.push(disk)
        parts.push('id=' + event.Id)
        parts.push('source=' + (oneLine(event.Source) || 'unknown'))
        parts.push('level=' + (level === 1 ? 'critical' : level === 3 ? 'warning' : level === 2 ? 'error' : 'info'))
        parts.push(describe(event, volumeLetters))
        if (event.Message)
            parts.push('msg="' + formatMessage(event.Message) + '"')
        parts.push('time=' + oneLine(event.Time))

        return parts.join(' | ')
    }

    // Windows PowerShell 5.1 has no Register-WinEvent, and an EventLogWatcher handler
    // runs on a thread whose console output never reaches us. So one long-lived
    // PowerShell process queries the System log every few seconds instead, and prints
    // one JSON line per new event. Reading the event log does not touch the drives,
    // unlike probing drive letters, so this stays safe on a NAS.
    //
    // Encoding: JSON is written as raw UTF-8 bytes, never through [Console]::Out.
    // Windows PowerShell encodes console output with the console code page (GBK, CP437,
    // ...), Node decodes it as UTF-8, and every non-ASCII character of the localised
    // event text ends up as U+FFFD boxes in the HFS log. That was the "大量方框".
    const PASSIVE_CHECK_SECONDS = 5
    const PASSIVE_RESTART_MS = 60000
    const DISK_MAP_TTL_MINUTES = 10
    let passiveRestartTimer = null
    let passiveStopped = false

    function startPassive() {

        passiveStopped = false
        const ids = new Set([...ERROR_IDS, ...REMOVAL_IDS])
        const idFilter = Array.from(ids).map(i => `EventID=${i}`).join(' or ')

        const script = `
            $ErrorActionPreference = 'Stop'
            # Take over from a listener left behind by a previous plugin instance (HFS can
            # reload a plugin without unloading it), then keep a single instance alive.
            $self = $PID
            Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -and $_.CommandLine.Contains('HFS-DiskMonitor-winevent') } |
                ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
            $mutex = New-Object System.Threading.Mutex($false, 'Local\\HFS-DiskMonitor-winevent')
            $acquired = $false
            # A listener killed by the block above leaves the mutex abandoned; WaitOne then
            # throws AbandonedMutexException *and* takes ownership, so start anyway.
            try { $acquired = $mutex.WaitOne(0) }
            catch [System.Threading.AbandonedMutexException] { $acquired = $true }
            catch { $acquired = $false }
            if (-not $acquired) { Write-Output 'already-running'; exit 0 }
            $xml = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[(${idFilter})]]</Select></Query></QueryList>'
            $lastId = 0
            try {
                $newest = Get-WinEvent -LogName System -MaxEvents 1 -ErrorAction SilentlyContinue
                if ($newest) { $lastId = [int]$newest.RecordId }
            } catch { }

            # UTF-8 bytes straight into the pipe. Do not touch [Console]::OutputEncoding:
            # an HFS-spawned PowerShell has no console, so the setter can throw and the
            # listener would die before logging anything.
            $out = [Console]::OpenStandardOutput()

            # ---------- disk identity ----------
            # Windows keeps the disk number in the localised text ("磁盘 5" / "Disk 5" /
            # "\\Device\\Harddisk5\\DR5"). Resolve it to model, serial and drive letters so
            # a warning says which physical drive is complaining. Win32_DiskDrive and
            # Win32_Volume only read cached storage descriptors (no SMART, no spin-up), and
            # the result is cached for ${DISK_MAP_TTL_MINUTES} minutes.
            $diskMap = @{}
            $diskMapAt = [datetime]::MinValue
            $volMap = @{}
            $volMapAt = [datetime]::MinValue

            function Update-DiskMap {
                $map = @{}
                try {
                    foreach ($d in (Get-CimInstance -ClassName Win32_DiskDrive -ErrorAction SilentlyContinue)) {
                        $sizeGb = 0
                        if ($d.Size) { $sizeGb = [math]::Round($d.Size / 1GB) }
                        $letters = @()
                        try {
                            $parts = Get-CimAssociatedInstance -InputObject $d -ResultClassName Win32_DiskPartition -ErrorAction SilentlyContinue
                            foreach ($p in $parts) {
                                $vols = Get-CimAssociatedInstance -InputObject $p -ResultClassName Win32_LogicalDisk -ErrorAction SilentlyContinue
                                foreach ($v in $vols) {
                                    if ($v.DeviceID) { $letters += [string]$v.DeviceID }
                                }
                            }
                        } catch { }
                        $map[[int]$d.Index] = @{
                            Model = [string]$d.Model
                            Serial = ([string]$d.SerialNumber).Trim()
                            SizeGB = $sizeGb
                            Letters = $letters
                        }
                    }
                } catch { }
                return $map
            }

            function Update-VolMap {
                $map = @{}
                try {
                    foreach ($v in (Get-CimInstance -ClassName Win32_Volume -ErrorAction SilentlyContinue)) {
                        $id = [string]$v.DeviceID
                        if ($id -notmatch 'Volume\\{([^}]+)\\}') { continue }
                        $key = $Matches[1].ToUpperInvariant()
                        $letters = @()
                        if ($v.DriveLetter) { $letters += [string]$v.DriveLetter }
                        $map[$key] = @{
                            Letters = $letters
                            Label = [string]$v.Label
                            FS = [string]$v.FileSystem
                        }
                    }
                } catch { }
                return $map
            }

            Write-Output 'watching'
            while ($true) {
                $events = @()
                try { $events = Get-WinEvent -FilterXml $xml -MaxEvents 50 -ErrorAction SilentlyContinue } catch { }
                foreach ($e in ($events | Sort-Object RecordId)) {
                    if ($e.RecordId -le $lastId) { continue }
                    $lastId = $e.RecordId
                    # Only Critical/Error/Warning. Event id 153 also exists in Kernel-Boot
                    # (virtualisation status, Information level) and would otherwise be
                    # reported as a disk error.
                    if ($e.Level -notin @(1, 2, 3)) { continue }

                    $msg = [string]$e.Message
                    if (-not $msg) { $msg = '' }

                    $diskNo = $null
                    if ($msg -match '(?:磁盘|Disk)\\s*(\\d+)') { $diskNo = [int]$Matches[1] }
                    elseif ($msg -match 'Harddisk(\\d+)') { $diskNo = [int]$Matches[1] }

                    if (($null -ne $diskNo) -and (-not $diskMap.ContainsKey($diskNo) -or ((Get-Date) - $diskMapAt).TotalMinutes -gt ${DISK_MAP_TTL_MINUTES})) {
                        $diskMap = Update-DiskMap
                        $diskMapAt = Get-Date
                    }

                    $model = ''
                    $serial = ''
                    $sizeGb = 0
                    $letters = @()
                    if (($null -ne $diskNo) -and $diskMap.ContainsKey($diskNo)) {
                        $d = $diskMap[$diskNo]
                        $model = [string]$d.Model
                        $serial = [string]$d.Serial
                        $sizeGb = [int]$d.SizeGB
                        $letters = @($d.Letters)
                    }

                    $volGuid = ''
                    $volLetters = @()
                    $volLabel = ''
                    $volFS = ''
                    if ($msg -match 'Volume\\{([0-9a-fA-F-]{36})\\}') {
                        $volGuid = $Matches[1].ToUpperInvariant()
                        if (-not $volMap.ContainsKey($volGuid) -or ((Get-Date) - $volMapAt).TotalMinutes -gt ${DISK_MAP_TTL_MINUTES}) {
                            $volMap = Update-VolMap
                            $volMapAt = Get-Date
                        }
                        if ($volMap.ContainsKey($volGuid)) {
                            $v = $volMap[$volGuid]
                            $volLetters = @($v.Letters)
                            $volLabel = [string]$v.Label
                            $volFS = [string]$v.FS
                        }
                    }

                    # Language-independent tokens, parsed out of the localised text.
                    $dev = ''
                    if ($msg -match '(?i)PDO[^\\r\\n:]{0,40}:\\s*(\\\\Device\\\\[^\\s,)]+)') { $dev = $Matches[1] }
                    elseif ($msg -match '(\\\\Device\\\\[^\\s,)]+)') { $dev = $Matches[1] }
                    elseif ($msg -match '(?i)((?:USBSTOR|USB|SCSI|NVME|IDE|STORAGE|PCI|SWD|ROOT|BTHENUM)\\\\[^\\s,)]+)') { $dev = $Matches[1] }

                    $lba = ''
                    if ($msg -match '(0x[0-9a-fA-F]+)') { $lba = $Matches[1] }

                    $payload = [ordered]@{
                        Id = [int]$e.Id
                        Source = [string]$e.ProviderName
                        LevelNum = [int]$e.Level
                        Time = $e.TimeCreated.ToString('o')
                        Message = $msg
                        Disk = $diskNo
                        Model = $model
                        Serial = $serial
                        SizeGB = $sizeGb
                        Letters = $letters
                        VolumeGuid = $volGuid
                        VolumeLetters = $volLetters
                        VolumeLabel = $volLabel
                        VolumeFS = $volFS
                        Device = $dev
                        Lba = $lba
                    }
                    $json = $payload | ConvertTo-Json -Compress
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json + [char]10)
                    $out.Write($bytes, 0, $bytes.Length)
                    $out.Flush()
                }
                Start-Sleep -Seconds ${PASSIVE_CHECK_SECONDS}
            }
        `

        psProcess = spawn('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true }
        )

        let buffer = ''

        psProcess.stdout.on('data', data => {
            // The listener writes UTF-8 bytes, so the split on '\n' can never fall inside
            // a multi-byte character (0x0A does not appear in UTF-8 continuation bytes).
            buffer += data.toString('utf8')
            let idx
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).replace(/^\uFEFF/, '').trim()
                buffer = buffer.slice(idx + 1)
                if (!line) continue
                try {
                    const event = JSON.parse(line)
                    const category = categorize(event)
                    if (!category)
                        continue

                    api.log(formatEvent(category, event))
                } catch (e) {
                    // Ignore non-JSON output (the 'watching' banner, PowerShell noise)
                }
            }
        })

        psProcess.stderr.on('data', data => {
            const msg = data.toString().trim()
            if (msg)
                api.log('[DiskMonitor] PowerShell error:', msg)
        })

        const startedAt = Date.now()
        psProcess.on('close', code => {
            psProcess = null
            if (passiveStopped)
                return
            if (Date.now() - startedAt < 30000) {
                // Either another listener already holds the mutex (plugin hot-reloaded
                // without unloading), or PowerShell refused to start.
                api.log('[DiskMonitor] Event listener stopped right away with code:', code, '- another listener may already be running')
                return
            }
            api.log('[DiskMonitor] Event listener exited with code:', code, '- restarting in ' + PASSIVE_RESTART_MS / 1000 + 's')
            passiveRestartTimer = api.setTimeout(() => {
                passiveRestartTimer = null
                if (!passiveStopped && !psProcess && api.getConfig('enabled'))
                    startPassive()
            }, PASSIVE_RESTART_MS)
        })
    }

    function stopPassive() {
        passiveStopped = true
        if (passiveRestartTimer) {
            clearTimeout(passiveRestartTimer)
            passiveRestartTimer = null
        }
        if (psProcess) {
            try { psProcess.kill() } catch (e) { /* ignore */ }
            psProcess = null
        }
    }

    // ---------- Lifecycle ----------

    function start() {

        if (timer) {
            clearInterval(timer)
            timer = null
        }

        const enabled = api.getConfig('enabled')
        const mode = normalizeMode(api.getConfig('monitorMode'))

        // The passive listener is long-lived: when start() runs again for an unchanged
        // configuration (HFS notifies subscribers right away), keep it instead of
        // killing and respawning PowerShell.
        if (!enabled || mode !== 'passive')
            stopPassive()
        else if (!psProcess)
            startPassive()

        if (enabled && mode === 'aggressive') {
            const interval = api.getConfig('interval') || 2
            timer = api.setInterval(checkDrives, interval * 1000)
        }
    }

    start()

    api.subscribeConfig(['enabled', 'interval', 'monitorMode'], () => {
        state.clear()
        start()
    })

    api.subscribeConfig('drives', () => {
        state.clear()
    })

    return {
        unload() {
            if (timer)
                clearInterval(timer)
            stopPassive()
        }
    }
}
