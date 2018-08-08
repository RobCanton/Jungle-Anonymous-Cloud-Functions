function sendNotification(admin, database, uid, title, body) {
    console.log("SWEEET! MAN!");
//    return new Promise((resolve, reject) => {
//
//        var badgeCount = 0;
//        const getUserNotificationSettings = database.ref(`users/settings/${uid}/pushNotifications`).once('value');
//        return getUserNotificationSettings.then(snapshot => {
//            if (snapshot.exists()) {
//                if (snapshot.val() == false) {
//                    return reject();
//                }
//            }
//            const getUnseenNotifications = database.ref(`users/notifications/${uid}`).orderByChild('seen').equalTo(false).once('value');
//            return getUnseenNotifications;
//        }).then(snapshot => {
//
//            badgeCount = Number(snapshot.numChildren());
//
//            const getUserToken = database.ref(`users/fcmToken/${uid}`).once('value');
//            return getUserToken;
//
//        }).then(snapshot => {
//            let token = snapshot.val();
//
//            let payload = {
//                "notification": {
//                    "title": title,
//                    "body": body,
//                    "badge": `${badgeCount}`
//                }
//            };
//
//
//            console.log("Send payload: ", payload);
//            const sendPushNotification = admin.messaging().sendToDevice(token, payload);
//            return sendPushNotification;
//        }).then(() => {
//            return resolve();
//        }).catch(error => {
//            return reject(error);
//        });
//    });
}

exports.sendNotification = function(admin, database, uid, title, body) {
    
    return new Promise((resolve, reject) => {

        var badgeCount = 0;
        const getUserNotificationSettings = database.ref(`users/settings/${uid}/pushNotifications`).once('value');
        return getUserNotificationSettings.then(snapshot => {
            if (snapshot.exists()) {
                if (snapshot.val() == false) {
                    return reject();
                }
            }
            const getUnseenNotifications = database.ref(`users/notifications/${uid}`).orderByChild('seen').equalTo(false).once('value');
            return getUnseenNotifications;
        }).then(snapshot => {

            badgeCount = Number(snapshot.numChildren());

            const getUserToken = database.ref(`users/fcmToken/${uid}`).once('value');
            return getUserToken;

        }).then(snapshot => {
            let token = snapshot.val();

            let payload = {
                "notification": {
                    "title": title,
                    "body": body,
                    "badge": `${badgeCount}`
                }
            };


            console.log("Send payload: ", payload);
            console.log("TOKEN: ", token);
            const sendPushNotification = admin.messaging().sendToDevice(token, payload);
            return sendPushNotification;
        }).then(() => {
            console.log("ALL GOOD!");
            return resolve();
        }).catch(error => {
            console.log("ERROR: ", error);
            return reject(error);
        });
    });
} 
