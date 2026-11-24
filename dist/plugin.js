exports.version = 2.7
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

    // Windows PowerShell 5.1 has no Register-WinEvent, and an EventLogWatcher handler
    // runs on a thread whose console output never reaches us. So one long-lived
    // PowerShell process queries the System log every few seconds instead, and prints
    // one JSON line per new event. Reading the event log does not touch the drives,
    // unlike probing drive letters, so this stays safe on a NAS.
    const PASSIVE_CHECK_SECONDS = 5
    const PASSIVE_RESTART_MS = 60000
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
            try { $acquired = $mutex.WaitOne(0) } catch { $acquired = $false }
            if (-not $acquired) { Write-Output 'already-running'; exit 0 }
            $xml = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[(${idFilter})]]</Select></Query></QueryList>'
            $lastId = 0
            try {
                $newest = Get-WinEvent -LogName System -MaxEvents 1 -ErrorAction SilentlyContinue
                if ($newest) { $lastId = [int]$newest.RecordId }
            } catch { }
            Write-Output 'watching'
            while ($true) {
                $events = @()
                try { $events = Get-WinEvent -FilterXml $xml -MaxEvents 50 -ErrorAction SilentlyContinue } catch { }
                foreach ($e in ($events | Sort-Object RecordId)) {
                    if ($e.RecordId -le $lastId) { continue }
                    $lastId = $e.RecordId
                    $payload = @{
                        Id = $e.Id
                        Source = $e.ProviderName
                        Level = $e.LevelDisplayName
                        Time = $e.TimeCreated.ToString('o')
                        Message = $e.Message
                    } | ConvertTo-Json -Compress
                    [Console]::Out.WriteLine($payload)
                    [Console]::Out.Flush()
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
            buffer += data.toString()
            let idx
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).trim()
                buffer = buffer.slice(idx + 1)
                if (!line) continue
                try {
                    const event = JSON.parse(line)
                    const category = categorize(event)
                    if (!category)
                        continue

                    const severity = (event.Id === 7 || event.Id === 55) ? 'ERROR' : 'WARNING'
                    api.log(
                        `[DiskMonitor] ${category.toUpperCase()} ${severity}:`,
                        'id=' + event.Id,
                        'source=' + event.Source,
                        'level=' + event.Level,
                        'time=' + event.Time,
                        'message=' + event.Message
                    )
                } catch (e) {
                    // Ignore non-JSON output
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


