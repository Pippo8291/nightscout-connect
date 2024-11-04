const { LocalStorage } = require('node-localstorage');

// Initialize localStorage with a storage path
const localStorage = new LocalStorage('./scratch'); // './scratch' is the directory where data will be stored

class DexcomSessionManager {
    constructor() {
        this.sessionData = null;
    }

    initSession(data) {
        this.sessionData = data;
        localStorage.setItem("dexcomSession", JSON.stringify(data));
    }

    getSession() {
        if (this.sessionData === null) {
            this.sessionData = JSON.parse(localStorage.getItem("dexcomSession"));
        }
        return this.sessionData;
    }
}

module.exports = new DexcomSessionManager();