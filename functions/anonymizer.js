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

exports.getUserAnonymousKey = function (uid, postID) {
    return new Promise((resolve, reject) => {

        const parentPostRef = firestore.collection('posts').doc(postID);
        const lexiconRef = parentPostRef.collection('lexicon').doc(uid);
        const getAnonKey = lexiconRef.get();
        return getAnonKey.then(snapshot => {
            if (snapshot.exists) {

                console.log(`ANON KEY ALREADY EXISTS!: ${snapshot.data()}`);
                return Promise.resolve(snapshot.data());

            } else {
                console.log(`GENERATE ANONYMOUS KEY`);
                return generateAnonymousKeyForPost(uid, postID, {});
            }
        }).then(result => {
            return resolve(result);
        }).catch(error => {
            return reject(`ERROR: ${error}`);
        })
    });
}

function isAnonKeyAvailable(key, uid, postID) {
    return new Promise(resolve => {
        const postRef = firestore.collection("posts").doc(postID);
        const getEntry = postRef.collection("lexicon").where("key", "==", anonKey).get();
        return getEntry.then(snapshot => {
            resolve(snapshot.isEmpty);
        });
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
            const key = `${adjective}${animal}`;
            anonObject = {
                adjective: adjective,
                animal: animal,
                color: color,
                key: key
            };
            flag = key in _attempted;
            console.log("isKeyAttempted: ", flag);
        }

        const postRef = firestore.collection("posts").doc(postID);
        const getEntry = postRef.collection("lexicon").where("key", "==", anonObject.key).get();
        getEntry.then(snapshot => {
            console.log("SNAPSHOT IS EMPTY: ", snapshot.empty);
            if (snapshot.empty) {
                console.log(`ANON: ${anonObject.key} EMPTY -> RESOLVE`);
                return Promise.resolve(anonObject);
            } else {
                console.log(`ANON: ${anonObject.key} TAKEN -> RECURSE`);
                _attempted[anonObject.key] = true;
                return generateAnonymousKeyForPost(uid, postID, _attempted);
            }
        }).then(_anonObject => {
            anonObject = _anonObject;
            const parentPostRef = firestore.collection('posts').doc(postID);
            const lexiconRef = parentPostRef.collection('lexicon').doc(uid);
            var lexiconObject = anonObject;
            lexiconObject['uid'] = uid;
            console.log("SETTING LEXICON!");

            const setLexiconEntry = lexiconRef.set(lexiconObject);
            const setLexiconMeta = database.ref(`posts/meta/${postID}/lexicon/${anonObject.key}`).set(uid);

            return Promise.all([setLexiconEntry, setLexiconMeta]);
        }).then(() => {
            return resolve(anonObject);
        }).catch(error => {
            console.log(`ERROR: ${error}`);
            return reject(error);
        });

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
