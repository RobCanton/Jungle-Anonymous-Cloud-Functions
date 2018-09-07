const path = require('path');
const os = require('os');
const anonNames = require('./anonNames.json');
const adjectives = anonNames["adjectives"];
const animals = anonNames["animals"];
const colors = anonNames["colors"];
const gradients = anonNames["gradients"];

var admin;
var database;
var firestore;


exports.setup = function (_admin, _database, _firestore) {
    admin = _admin;
    database = _database;
    firestore = _firestore;
};

exports.anonymizeFile = function (inputFilePath, outputFilePath) {
    return new Promise((resolve, reject) => {
        const tempLocalFile = path.join(os.tmpdir(), inputFilePath);
        const tempLocalDir = path.dirname(tempLocalFile);
        const bucket = admin.storage().bucket();

        const file = bucket.file(inputFilePath);

        return file.move(outputFilePath).then(() => {
            return resolve(null);
        }).catch(error => {
            return reject(error);
        })
    });
};

exports.getUserLexiconEntry = function (uid, postID, isAnon) {
    return new Promise((resolve, reject) => {
        const getLexiconEntry = database.child(`posts/lexicon/${postID}/${uid}`).once('value');
        return getLexiconEntry.then(snapshot => {
            if (snapshot.exists()) {
                return Promise.resolve(snapshot.val());
            } else {
                if (isAnon) {
                    return generateAnonymousKeyForPost(uid, postID, {});
                } else {
                    return setUserAuthorLexiconEntry(uid, postID);
                }
            }
        }).then(result => {
            return resolve(result);
        }).catch(error => {
            return reject(`ERROR: ${error}`);
        });
    });
}

function setUserAuthorLexiconEntry(uid, postID) {
    return new Promise((resolve, reject) => {
        var profile;
        const getUserProfile = database.child(`users/profile/${uid}`).once('value');
        return getUserProfile.then(_profile => {
            if (_profile.exists()) {
                profile = _profile.val();
                profile['key'] = profile['username'].toLowerCase();
                const setLexiconEntry = database.child(`posts/lexicon/${postID}/${uid}`).set(profile);
                return setLexiconEntry;
            } else {
                return Promise.reject('No user profile found');
            }
        }).then(() => {
            return resolve(profile);
        }).catch(e => {
            return reject(e);
        });
    });
}

exports.getUserAnonymousKey = function (uid, postID) {
    return new Promise((resolve, reject) => {
        return resolve();
    });
}

function generateAnonymousKeyForPost(uid, postID, attemped) {
    return new Promise((resolve, reject) => {
        var _attempted = attemped;
        var flag = true;
        var anonObject = {};
        while (flag) {
            const adjective = randomAdjective();
            const animal = randomAnimal();
            const color = randomColor();
            const key = `${adjective}${animal}`.toLowerCase();
            anonObject = {
                adjective: adjective,
                animal: animal,
                color: color,
                key: key
            };
            flag = key in _attempted;
        }


        const getEntry = database.child(`posts/lexicon/${postID}`).orderByChild('key').equalTo(anonObject.key).once('value');
        return getEntry.then(snapshot => {
            if (!snapshot.exists()) {
                return Promise.resolve(anonObject);
            } else {
                _attempted[anonObject.key] = true;
                return generateAnonymousKeyForPost(uid, postID, _attempted);
            }
        }).then(_anonObject => {
            anonObject = _anonObject;
            const setLexiconMeta = database.child(`posts/lexicon/${postID}/${uid}`).set(anonObject);
            return setLexiconMeta;
        }).then(() => {
            return resolve(anonObject);
        }).catch(error => {
            console.log(`ERROR: ${error}`);
            return reject(error);
        });

    });
}

exports.systemSaveAllAnonNames = function (systemDatabase) {
    return new Promise((resolve, reject) => {
        var updateobject = {};
		for (var i = 0; i < adjectives.length; i++) {
			for (var j = 0; j < animals.length; j++) {
				const name = `${adjectives[i].toLowerCase()}${animals[j].toLowerCase()}`;
				updateobject[`anon/names/${name}`] = true;
			}
		}
		return systemDatabase.update(updateobject).then (() => {
			return resolve();
		}).catch( e => {
			return reject(e);
		})
    });
}


function randomAdjective() {
    return adjectives[Math.floor(Math.random() * adjectives.length)];
}

function randomAnimal() {
    return animals[Math.floor(Math.random() * animals.length)];
}

function randomColor() {
    return colors[Math.floor(Math.random() * colors.length)];
}

function matchingGradient() {
    return gradients[Math.floor(Math.random() * gradients.length)];
}

exports.randomAdjective = randomAdjective;

exports.randomAnimal = randomAnimal;

exports.randomColor = randomColor;

exports.matchingGradient = matchingGradient;
