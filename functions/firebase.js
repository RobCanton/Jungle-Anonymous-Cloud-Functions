const functions = require('firebase-functions');
const admin = require('firebase-admin');


var serviceAccount = require("./serviceAccountKey.json");

exports.initialize = function () {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://jungle-anonymous.firebaseio.com",
        storageBucket:"gs://jungle-anonymous.appspot.com"
    });
}

exports.admin = function () {
    return admin;
};

exports.functions = function () {
    return functions;
};

exports.firestore = function () {
    return admin.firestore();
};

exports.database = function () {
    return admin.database();
};
