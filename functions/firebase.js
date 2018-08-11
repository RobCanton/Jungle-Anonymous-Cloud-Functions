const functions = require('firebase-functions');
const admin = require('firebase-admin');


var serviceAccount = require("./serviceAccountKey.json");

var _firestore;
exports.initialize = function () {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://jungle-anonymous.firebaseio.com",
        storageBucket: "gs://jungle-anonymous.appspot.com"
    });

    _firestore = admin.firestore();
    const settings = { /* your settings... */
        timestampsInSnapshots: true
    };
    _firestore.settings(settings);

}

exports.admin = function () {
    return admin;
};

exports.functions = function () {
    return functions;
};

exports.firestore = function () {
    return _firestore; //admin.firestore().settings(settings);
};

exports.database = function () {
    return admin.database();
};
