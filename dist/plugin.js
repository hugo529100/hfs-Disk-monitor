exports.version = 2
exports.apiRequired = 10.0
exports.description = "NAS-optimized drive monitor. Logs debug message only when monitored drive is lost."
exports.repo = "Hug3O/Disk-monitor"
exports.config = {
    enabled: {
        type: 'boolean',
        label: 'Enable monitoring',
        defaultValue: true
    },
    nasMode: {
        type: 'boolean',
        label: 'NAS multi-bay optimization mode',
        helperText: 'Reduce polling frequency to avoid waking sleeping HDDs',
        defaultValue: true
    },
    drives: {
        type: 'multiselect',
        label: 'Drives to monitor',
        helperText: 'Select drive letters to monitor',
        options: {
            "D:": "D:",
            "E:": "E:",
            "F:": "F:",
            "G:": "G:",
            "H:": "H:",
            "I:": "I:",
            "J:": "J:",
            "K:": "K:",
            "L:": "L:",
            "M:": "M:",
            "N:": "N:",
            "O:": "O:",
            "P:": "P:",
            "Q:": "Q:",
            "R:": "R:",
            "S:": "S:",
            "T:": "T:",
            "U:": "U:",
            "V:": "V:",
            "W:": "W:",
            "X:": "X:",
            "Y:": "Y:",
            "Z:": "Z:"
        },
        defaultValue: []
    },
    interval: {
        type: 'number',
        label: 'Check interval (seconds)',
        min: 2,
        defaultValue: 2
    }
}

exports.init = api => {

    const fs = api.require('fs')

    let timer
    let state = new Map()

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

    function start() {

        if (timer)
            clearInterval(timer)

        if (!api.getConfig('enabled'))
            return

        let interval = api.getConfig('interval') || 2

        if (api.getConfig('nasMode')) {
            interval = Math.max(interval, 5) // NAS安全下限
        }

        timer = api.setInterval(checkDrives, interval * 1000)
    }

    start()

    api.subscribeConfig(['enabled', 'interval', 'nasMode'], () => {
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
        }
    }
}
