// state — единая точка доступа к API + очистка ресурсов
let api = null
const timers = new Set()

module.exports = {
  get api() { return api },
  init(syntee) { api = syntee },
  every(intervalMs, fn) {
    const t = setInterval(fn, intervalMs)
    timers.add(t)
    return () => { clearInterval(t); timers.delete(t) }
  },
  cleanup() {
    for (const t of timers) clearInterval(t)
    timers.clear()
    api = null
  },
}
