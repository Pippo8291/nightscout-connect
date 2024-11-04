const { LocalStorage } = require('node-localstorage');

// Initialize localStorage with a storage path
const localStorage = new LocalStorage('./scratch'); // './scratch' is the directory where data will be stored
class GlookoSessionManager {
    constructor() {
        this.sessionData = null;
    }

    initSession(data) {
        this.sessionData = data;
        localStorage.setItem("glookoSession", JSON.stringify(data));
    }

    getSession() {
        if (this.sessionData === null) {
            this.sessionData = JSON.parse(localStorage.getItem("glookoSession"));
        }
        return this.sessionData;
    }
}

module.exports = new GlookoSessionManager();