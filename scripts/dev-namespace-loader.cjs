// Keep dev CSS, DOM IDs and Angular selectors separate when both plugins are loaded.
module.exports = function (source) {
    return source
        .replace(/\b(tqc|wqc)-/g, '$1-dev-')
        .replace(/quick-commands-settings-tab/g, 'quick-commands-dev-settings-tab')
}
