const firebase = require('./firebase.js');
firebase.initialize();

const functions = firebase.functions();
const admin = firebase.admin();
const database = firebase.database();
const firestore = firebase.firestore();

const NodeGeocoder = require('node-geocoder');
const utilities = require('./utilities.js');

const findHashtags = require('find-hashtags');
const GOOGLE_PLACES_API_KEY = 'AIzaSyCTo6ejt9CDHW0BpbyhTQ8rcHfgTnDZZ2g';
const swearjar = require('swearjar');

const anonymizer = require('./anonymizer.js');
anonymizer.setup(admin, database, firestore);

var options = {
    provider: 'google',

    // Optional depending on the providers
    httpAdapter: 'https', // Default
    apiKey: GOOGLE_PLACES_API_KEY, // for Mapquest, OpenCage, Google Premier
    formatter: null // 'gpx', 'string', ...
};

var geocoder = NodeGeocoder(options);

const util = require('util');

const promiseReflect = require('promise-reflect');

const algoliasearch = require('algoliasearch');

// configure algolia
const algolia = algoliasearch(
    'O8UGJJNEB6',
    '456e227c40f1ad76766621bc64d13b12'
);

const algolia_client = algoliasearch(
    'O8UGJJNEB6',
    '0df072a9b2f30dfb8c0e312cb52200ff'
);

const postsAdminIndex = algolia.initIndex('posts');
const popularPostsAdminIndex = algolia.initIndex('popularPosts');
const commentsAdminIndex = algolia.initIndex('comments');

const popularPostsIndex = algolia_client.initIndex('popularPosts');
const postsIndex = algolia_client.initIndex('posts');
const commentsIndex = algolia_client.initIndex('comments');

function deleteAllUsers(nextPageToken) {
    // List batch of users, 1000 at a time.


    admin.auth().listUsers(1000, nextPageToken)
        .then(function (listUsersResult) {
            var promises = [];
            listUsersResult.users.forEach(function (userRecord) {

                console.log("user", userRecord.toJSON());
                if (userRecord.uid != null) {
                    const deleteUser = admin.auth().deleteUser(userRecord.uid);
                    promises.push(deleteUser);
                }
            });
            return Promise.all(promises);
        }).then(() => {
            return;
        })
        .catch(function (error) {
            console.log("Error listing users:", error);
        });
}
// 

exports.deleteAllUsers = functions.https.onRequest((req, res) => {
    deleteAllUsers();
    return res.send({
        success: true
    });
});

exports.cleanUp = functions.https.onRequest((req, res) => {

    var now = new Date();
    var tenMinutesAgo = Date.now() - 3 * 60 * 1000
    var batchSize = 20;
    var removedPostsRef = firestore.collection('posts')
        .where('removedAt', '<', tenMinutesAgo)
        .orderBy('removedAt');
    var query = removedPostsRef.limit(batchSize);
    return new Promise((resolve, reject) => {
        deleteQueryBatch(firestore, query, batchSize, resolve, reject);
    }).then(() => {
        return res.send({
            success: true
        });
    }).catch(e => {
        console.log("Error: ", e);
        return res.send({
            success: false,
            error: e
        });
    });
});

exports.calculateTrending = functions.https.onRequest((req, res) => {

    var now = new Date();
    var oneWeekAgo = new Date(now.getTime() - (60 * 60 * 24 * 7 * 1000));
    const getAllFacets = postsAdminIndex.search({
        facets: ['hashtags'],
        maxValuesPerFacet: 10,
        numericFilters: 'createdAt > 1531886240936'
    });

    var trendingHashtags = [];

    return getAllFacets.then(results => {
        var promises = [];

        if (results.facets) {
            if (results.facets.hashtags) {
                const hashtags = results.facets.hashtags;
                for (var tag in hashtags) {
                    trendingHashtags.push({
                        tag: tag,
                        count: hashtags[tag]
                    });

                    const getTopPostForTag = popularPostsAdminIndex.search({
                        facetFilters: [`hashtags:${tag}`],
                        offset: 0,
                        length: 5
                    });
                    promises.push(getTopPostForTag);
                }
            }
        }

        return Promise.all(promises);

    }).then(topResults => {
        //console.log(`TOP RESULTS: ${util.inspect(topResults, false, null)}`);
        var trendingObject = {};
        for (var i = 0; i < topResults.length; i++) {
            const result = topResults[i];
            var posts = [];

            for (var j = 0; j < result.hits.length; j++) {
                var hit = result.hits[j];
                hit.id = hit.objectID;
                delete hit.objectID;
                delete hit.uid;
                delete hit._geoloc;
                delete hit._highlightResult;
                delete hit.anon.uid;
                posts.push(hit);
            }

            const trendingHashtag = trendingHashtags[i];

            trendingObject[trendingHashtag.tag] = {
                count: trendingHashtag.count,
                posts: posts
            }
        }



        const setTrendingHashtags = database.ref(`trending/hashtags`).set(trendingObject);
        return setTrendingHashtags;
    }).then(() => {
        return res.send({
            success: true
        });
    })

});

exports.requestNewPostID = functions.https.onCall((data, context) => {

    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;
    const email = context.auth.token.email;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    if (email == null) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    const getUserTimeout = firestore.collection('userTimeouts').doc(uid).get();
    return getUserTimeout.then(result => {
        const data = result.data();
        if (data.canPost == true) {
            const postObject = {
                "status": "pending",
                "createdAt": Date.now()
            };
            const addPostDoc = firestore.collection('posts').add(postObject);

            return addPostDoc;
        } else {
            return Promise.reject();
        }
    }).then(ref => {

        return {
            "success": true,
            "postID": ref.id
        };
    }).catch(() => {
        return {
            "success": false
        };
    });



});

exports.myRegion = functions.https.onCall((data, context) => {
    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;
    const lat = data.lat;
    const lng = data.lng;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    return geocoder.reverse({
        lat: lat,
        lon: lng
    }).then(geoResponse => {
        if (geoResponse) {
            const body = geoResponse[0];

            const city = body["city"];
            const country = body["country"];
            const countryCode = body["countryCode"];

            return {
                city: city,
                country: country,
                countryCode: countryCode
            };
        }
    }).catch(e => {
        console.log("Error: ", e);
        return {
            error: e
        };
    })
});

exports.addPost = functions.https.onCall((data, context) => {

    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;
    const email = context.auth.token.email;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    if (email == null) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    const createdAt = Date.now();

    var postObject;
    var anonObject;
    var lat;
    var lon;
    var region;
    var location;

    const postID = data.postID;

    const thumbnailJPGInputFilePath = `/userPosts/${uid}/${postID}/thumbnail.jpg`;
    const thumbnailJPGOutputFilePath = `publicPosts/${postID}/thumbnail.jpg`;

    var anonymizeFiles = [Promise.resolve()];

    if (data.attachments != null) {
        if (data.attachments.video != null) {

            const videoInputFilePath = `/userPosts/${uid}/${postID}/video.mp4`;
            const videoOutputFilePath = `publicPosts/${postID}/video.mp4`;

            const thumbnailInputFilePath = `/userPosts/${uid}/${postID}/thumbnail.gif`;
            const thumbnailOutputFilePath = `publicPosts/${postID}/thumbnail.gif`;

            anonymizeFiles = [
                anonymizer.anonymizeFile(videoInputFilePath, videoOutputFilePath),
                anonymizer.anonymizeFile(thumbnailInputFilePath, thumbnailOutputFilePath),
                anonymizer.anonymizeFile(thumbnailJPGInputFilePath, thumbnailJPGOutputFilePath)
            ];

        } else if (data.attachments.image != null) {
            const imageInputFilePath = `/userPosts/${uid}/${postID}/image.jpg`;
            const imageOutputFilePath = `publicPosts/${postID}/image.jpg`;

            anonymizeFiles = [
                anonymizer.anonymizeFile(imageInputFilePath, imageOutputFilePath),
                anonymizer.anonymizeFile(thumbnailJPGInputFilePath, thumbnailJPGOutputFilePath)
            ];

        }
    }


    return Promise.all(anonymizeFiles).then(() => {
        const text = data.text;
        const attachments = data.attachments;

        const adjective = anonymizer.randomAdjective();
        const animal = anonymizer.randomAnimal();
        const color = anonymizer.randomColor();
        const gradient = anonymizer.matchingGradient();
        const anonKey = `${adjective}${animal}`;
        location = data.location;


        anonObject = {
            "key": anonKey,
            "adjective": adjective,
            "animal": animal,
            "color": color
        };

        postObject = {
            "anon": anonObject,
            "text": text,
            "textClean": swearjar.censor(text),
            "createdAt": createdAt,
            "votes": 0,
            "numReplies": 0,
            "status": "active",
            "hashtags": findHashtags(text),
            "parent": "NONE",
            "replyTo": "NONE",
            "gradient": gradient
        };

        if (attachments) {
            postObject["attachments"] = attachments;
        }

        if (location != null) {
            lat = location.lat;
            lon = location.lng;
            region = location.region;
            postObject["location"] = region;
        }


        const postRef = firestore.collection('posts').doc(postID);

        var batch = firestore.batch();

        batch.set(postRef, postObject);


        var lexiconObject = anonObject;
        lexiconObject["uid"] = uid;

        var lexiconRef = postRef.collection('lexicon').doc(uid);
        batch.set(lexiconRef, lexiconObject);

        var userObject = {
            lastPostedAt: createdAt,
            canPost: false,
            progress: 0
        };

        var userTimeoutRef = firestore.collection('userTimeouts').doc(uid);
        batch.set(userTimeoutRef, userObject);

        return batch.commit();
    }).then(() => {

        var record = postObject;

        record.uid = uid;

        if (lat && lon) {
            record._geoloc = {
                lat: lat,
                lng: lon
            };
        }

        record.objectID = postID;
        return postsAdminIndex.saveObject(record);

    }).then(() => {

        var lexicon = {};
        lexicon[anonObject.key] = uid;

        var metaObject = {
            author: uid,
            lexicon: lexicon
        };

        var updateObject = {};
        updateObject[`posts/subscribers/${postID}/${uid}`] = true
        updateObject[`posts/meta/${postID}`] = metaObject;

        const setPostMeta = database.ref().update(updateObject);
        return setPostMeta;

    }).then(() => {
        return {
            "success": true,
            "msg": "We good"
        };
    }).catch(e => {
        console.log("Error: ", e);
        return {
            "success": false,
            "msg": "Error"
        };
    });
});

exports.addComment = functions.https.onCall((data, context) => {

    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;
    const email = context.auth.token.email;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    if (email == null) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    const postID = data.postID;
    const text = data.text;

    const textClean = swearjar.censor(text);
    const replyTo = data.replyTo;

    const parentPostRef = firestore.collection('posts').doc(postID);

    var anonObject = {};

    var commentObject = {};
    const getAnonKey = parentPostRef.collection('lexicon').doc(uid);

    var replyID;
    var postAuthor;
    var lexicon = {};

    const getPostMeta = database.ref(`posts/meta/${postID}`).once('value');
    return getPostMeta.then(result => {
        if (result.exists()) {
            const postMeta = result.val()
            postAuthor = postMeta.author;

            if (postMeta.lexicon) {
                lexicon = postMeta.lexicon;
            }
            return anonymizer.getUserAnonymousKey(uid, postID);

        } else {
            throw new functions.https.HttpsError('failed-precondition', 'Unable to add comment.');
        }
    }).then(_anonObject => {
        anonObject = _anonObject;

        commentObject = {
            "anon": anonObject,
            "text": text,
            "textClean": textClean,
            "createdAt": Date.now(),
            "parent": postID,
            "status": "active",
            "numReplies": 0,
            "hashtags": findHashtags(text),
            "votes": 0,
            "score": 0
        };

        if (replyTo) {
            commentObject["replyTo"] = replyTo;
        } else {
            commentObject["replyTo"] = postID;
        }

        var addComment = firestore.collection('posts').add(commentObject);

        return addComment;
    }).then(ref => {

        replyID = ref.id;
        var updateObject = {};
        updateObject[`posts/meta/${replyID}/author`] = uid;
        updateObject[`posts/meta/${replyID}/parent`] = postID;

        updateObject[`posts/replies/${postID}/${replyID}`] = true;
        updateObject[`posts/commenters/${postID}/${uid}`] = true;
        //updateObject[`tasks/posts/${postID}/replies`] = true;
        //updateObject[`tasks/posts/${postID}/commenters`] = true;
        updateObject[`posts/subscribers/${postID}/${uid}`] = true;

        if (replyTo) {
            updateObject[`posts/replies/${replyTo}/${replyID}`] = true;
            updateObject[`posts/commenters/${replyTo}/${replyID}`] = true;
            //updateObject[`tasks/posts/${replyTo}/replies`] = true;
            //updateObject[`tasks/posts/${replyTo}/commenters`] = true;
        }

        const update = database.ref().update(updateObject);
        return update;
    }).then(() => {
        var record = commentObject;

        record.uid = uid;

        record.objectID = replyID;
        return commentsAdminIndex.saveObject(record);

    }).then(() => {
        const getSubscribers = database.ref(`posts/subscribers/${postID}`).once('value');
        return getSubscribers;
    }).then(_subscribers => {
        var subscribers = _subscribers.val();
        const mentions = extractMentions(text);
        var mentionedUIDs = {};

        for (var i = 0; i < mentions.length; i++) {
            const anonKey = mentions[i].substring(1);
            const uid = lexicon[anonKey];
            mentionedUIDs[uid] = true;
        }

        var notificationPromises = [];
        for (var subscriberID in subscribers) {
            if (!subscribers[subscriberID]) {
                //console.log("NOT SUBSCRIBED -> IGNORE: ", subscriberID);
            } else if (subscriberID === uid || subscriberID == uid || !subscribers[subscriberID]) {
                //console.log("SUBSCRIBER IS SENDER -> IGNORE: ", subscriberID);
            } else {
                //console.log("SEND TO SUBSCRIBER: ", subscriberID);

                var notificationObject = {
                    anon: anonObject,
                    timestamp: Date.now(),
                    type: "POST_REPLY",
                    postID: postID,
                    replyID: replyID,
                    mention: subscriberID in mentionedUIDs,
                    seen: false,
                    text: trim(text),
                    name: anonObject.key
                };

                if (replyTo) {
                    notificationObject["replyTo"] = replyTo;
                }

                const notificationsRef = database.ref(`users/notifications/${subscriberID}`).push();
                const setNotification = notificationsRef.set(notificationObject);

                notificationPromises.push(setNotification);
            }
        }

        return Promise.all(notificationPromises.map(promiseReflect));

    }).then(ref => {

        return {
            "success": true,
            "id": replyID,
            "comment": commentObject,
            "replyTo": replyTo
        };
    }).catch(e => {
        console.log("Error: ", e);
        throw new functions.https.HttpsError('failed', error);
    })
});

function populatePosts(_posts, uid) {
    return new Promise((resolve, reject) => {
        var posts = _posts;
        var promises = [];

        for (var i = 0; i < posts.length; i++) {
            const post = posts[i];
            const getPostAuthor = database.ref(`posts/meta/${post.id}/author`).once('value');
            promises.push(getPostAuthor);
        }
        return Promise.all(promises).then(results => {
            for (var i = 0; i < results.length; i++) {
                const result = results[i];
                const isYou = result.val() === uid;
                posts[i]['isYou'] = isYou;
            }
            return resolve(posts);
        }).catch(e => {
            return reject(e);
        })
    });
}

function populateComments(_comments, uid) {
    return new Promise((resolve, reject) => {
        var comments = _comments;
        var parentPosts = {};
        var promises = [];

        for (var i = 0; i < comments.length; i++) {
            const comment = comments[i];
            parentPosts[comment.parent] = true;
        }

        for (var postID in parentPosts) {
            const getParentPost = firestore.collection('posts').doc(postID).get();
            promises.push(getParentPost);
        }

        return Promise.all(promises).then(results => {
            for (var k = 0; k < results.length; k++) {
                const result = results[k];
                var parentData = result.data();
                parentData['id'] = result.id;
                parentPosts[result.id] = parentData;
            }

            for (var i = 0; i < comments.length; i++) {
                comments[i].parentPost = parentPosts[comments[i].parent];
            }
            return resolve(comments);
        }).catch(e => {
            return reject(e);
        })
    });
}


function fetchCommentsAndPopulate(postID, uid, query) {
    return new Promise((resolve, reject) => {
        var comments = [];

        const getMyAnon = firestore.collection('posts').doc(postID).collection('lexicon').doc(uid).get();
        var anonKey = "";
        getMyAnon.then(anon => {
            if (anon.data()) {
                anonKey = anon.data().key;
            }
            return query;
        }).then(snapshot => {
            var promises = [];
            snapshot.forEach(function (comment) {
                var commentData = comment.data();
                var commentAnonKey = commentData.anon.key;
                commentData['id'] = comment.id;
                commentData['isYou'] = commentAnonKey === anonKey;
                comments.push(commentData);
                const getSubReplies = firestore.collection('posts')
                    .where('replyTo', '==', comment.id)
                    .orderBy('createdAt', 'desc')
                    .limit(3)
                    .get();

                promises.push(getSubReplies);
            });
            return Promise.all(promises);
        }).then(subRepliesArray => {
            for (var i = 0; i < subRepliesArray.length; i++) {
                const subReplies = subRepliesArray[i];
                var replies = [];
                subReplies.forEach(function (subReply) {
                    var subReplyData = subReply.data();
                    var subReplyAnonKey = subReplyData.anon.key;
                    subReplyData['id'] = subReply.id;
                    subReplyData['isYou'] = subReplyAnonKey === anonKey;
                    replies.push(subReplyData);

                });
                comments[i]['replies'] = replies;
            }
            return resolve(comments);
        }).catch(e => {
            return reject(e);
        });
    });
}

exports.userAccount = functions.https.onCall((data, context) => {
    const uid = context.auth.uid;
    const email = context.auth.token.email;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    if (email == null) {
        return {
            success: true,
            type: "anonymous",
            settings: {
                locationServices: false,
                pushNotifications: false,
                safeContentMode: false
            }
        };
    } else {
        var isReturningUser = false;
        var timeoutObject = {
            canPost: true
        };
        const getUserData = firestore.collection('users').doc(uid).get();
        return getUserData.then(snapshot => {
            isReturningUser = snapshot.exists
            if (snapshot.exists) {
                return Promise.resolve();
            } else {
                const profileData = {
                    type: "authenticated"
                }
                const setUserData = firestore.collection('users').doc(uid).set(profileData);
                return setUserData;
            }
        }).then(() => {
            const userTimeoutRef = firestore.collection('userTimeouts').doc(uid);
            if (isReturningUser) {
                const getUserTimeout = userTimeoutRef.get();
                return getUserTimeout;
            } else {
                const setUserTimeout = userTimeoutRef.set(timeoutObject);
                return setUserTimeout;
            }

        }).then(snapshot => {
            if (isReturningUser) {
                timeoutObject = snapshot.data();
            }
            const getUserSettings = database.ref(`users/settings/${uid}`).once('value');
            return getUserSettings;
        }).then(snapshot => {
            return {
                success: true,
                type: "email",
                settings: snapshot.val(),
                timeout: timeoutObject
            };
        }).catch(e => {
            console.log("Error: ", e);
            return {
                success: false
            };
        })
    }
});

exports.recentPosts = functions.https.onCall((data, context) => {

    const offset = data.offset;
    const limit = data.limit;

    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    const rootPostsRef = firestore.collection('posts').where('status', '==', 'active').where('parent', '==', 'NONE');
    const postsRef = rootPostsRef.orderBy('createdAt', 'desc');

    var queryRef;

    if (offset) {
        queryRef = postsRef.startAfter(offset).limit(limit).get();
    } else {
        queryRef = postsRef.limit(limit).get();
    }

    return queryRef.then(snapshot => {
        var posts = [];
        snapshot.forEach(function (post) {
            var postData = post.data();
            postData['id'] = post.id;
            postData['isYou'] = false;
            posts.push(postData);
        })

        return populatePosts(posts, uid);
    }).then(posts => {
        return {
            success: true,
            results: posts
        };
    }).catch(e => {
        console.log("Error: ", e);
        return {
            success: false,
            error: e
        };
    });
});

exports.recentPostsRefresh = functions.https.onCall((data, context) => {

    const offset = data.offset;
    const limit = data.limit;

    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    const rootPostsRef = firestore.collection('posts').where('status', '==', 'active').where('parent', '==', 'NONE');
    const postsRef = rootPostsRef.orderBy('createdAt');

    var queryRef;

    if (offset) {
        queryRef = postsRef.startAfter(offset).get();
    } else {
        queryRef = postsRef.get();
    }

    return queryRef.then(snapshot => {
        var posts = [];
        snapshot.forEach(function (post) {
            var postData = post.data();
            postData['id'] = post.id;
            postData['isYou'] = false;
            posts.push(postData);
        })

        return populatePosts(posts, uid);
    }).then(posts => {
        return {
            success: true,
            results: posts
        };
    }).catch(e => {
        consle.log("Error: ", e);
        return {
            success: false,
            error: e
        };
    });
});

exports.popularPosts = functions.https.onCall((data, context) => {

    const offset = data.offset;
    const length = data.length;


    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    var queryParams = {
        facets: ["*"],
        offset: offset,
        length: length
    };

    return popularPostsIndex.search(queryParams).then(content => {
        var posts = [];
        for (var i = 0; i < content.hits.length; i++) {
            var post = content.hits[i];
            post['isYou'] = false;
            post['id'] = post['objectID'];
            posts.push(post);
        }

        return populatePosts(posts, uid);
    }).then(posts => {
        return {
            success: true,
            results: posts
        };
    }).catch(e => {
        console.log("Error: ", e);
        return {
            success: false,
            error: e
        };
    });
});

exports.postReplies = functions.https.onCall((data, context) => {

    const postID = data.postID;
    const offset = data.offset;
    const limit = data.limit;

    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }


    const rootPostsRef = firestore.collection('posts').where('status', '==', 'active').where('replyTo', '==', postID);
    const postsRef = rootPostsRef.orderBy('createdAt');

    var query;

    if (offset) {
        query = postsRef.startAfter(offset).limit(limit).get();
    } else {
        query = postsRef.limit(limit).get();
    }

    return fetchCommentsAndPopulate(postID, uid, query).then(comments => {
        return {
            success: true,
            results: comments
        };
    }).catch(e => {
        console.log("Error: ", e);
        return {
            success: false,
            error: e
        };
    });
});

exports.searchPosts = functions.https.onCall((data, context) => {

    const text = data.text;
    const offset = data.offset;
    const length = data.length;
    const searchType = data.searchType;


    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    const isHashtag = text.substring(0, 1) === "#";
    const containsWhitespace = text.indexOf(' ') >= 0;
    var queryParams;
    if (isHashtag && !containsWhitespace) {
        let searchText = text.substr(1);
        queryParams = {
            facetFilters: [`hashtags:${searchText}`],
            offset: offset,
            length: length
        }
    } else {
        queryParams = {
            query: text,
            offset: offset,
            length: length
        }
    }
    var searchIndex = postsIndex;

    if (searchType === "popular") {
        searchIndex = popularPostsIndex;
    }

    return searchIndex.search(queryParams).then(content => {
        var posts = [];
        for (var i = 0; i < content.hits.length; i++) {
            var post = content.hits[i];
            post['isYou'] = false;
            post['id'] = post['objectID'];
            posts.push(post);
        }

        return populatePosts(posts, uid);
    }).then(posts => {
        return {
            success: true,
            results: posts
        };
    }).catch(e => {
        console.log("Error: ", e);
        return {
            success: false,
            error: e
        };
    });

});

exports.nearbyPosts = functions.https.onCall((data, context) => {

    const offset = data.offset;
    const length = data.length;
    const distance = data.distance;
    const lat = data.lat;
    const lng = data.lng;


    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    var queryParams = {
        offset: offset,
        length: length,
        aroundLatLng: `${lat}, ${lng}`,
        aroundRadius: distance
    }

    return postsIndex.search(queryParams).then(content => {
        var posts = [];
        for (var i = 0; i < content.hits.length; i++) {
            var post = content.hits[i];
            post['isYou'] = false;
            post['id'] = post['objectID'];
            posts.push(post);
        }

        return populatePosts(posts, uid);
    }).then(posts => {
        return {
            success: true,
            results: posts
        };
    }).catch(e => {
        console.log("Error: ", e);
        return {
            success: false,
            error: e
        };
    });
});

exports.myPosts = functions.https.onCall((data, context) => {

    const offset = data.offset;
    const length = data.length;


    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    var queryParams = {
        facetFilters: [`uid:${uid}`],
        offset: offset,
        length: length
    }

    return postsIndex.search(queryParams).then(content => {
        var posts = [];
        for (var i = 0; i < content.hits.length; i++) {
            var post = content.hits[i];
            post['isYou'] = true;
            post['id'] = post['objectID'];
            posts.push(post);
        }

        return {
            success: true,
            results: posts
        };
    }).catch(e => {
        console.log("Error: ", e);
        return {
            success: false,
            error: e
        };
    });

});

exports.myComments = functions.https.onCall((data, context) => {

    const offset = data.offset;
    const length = data.length;


    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    var queryParams = {
        facetFilters: [`uid:${uid}`],
        offset: offset,
        length: length
    }

    return commentsIndex.search(queryParams).then(content => {
        var posts = [];
        for (var i = 0; i < content.hits.length; i++) {
            var post = content.hits[i];
            post['isYou'] = true;
            post['id'] = post['objectID'];
            posts.push(post);
        }

        return populateComments(posts, uid);
    }).then(posts => {
        return {
            success: true,
            results: posts
        };
    }).catch(e => {
        console.log("Error: ", e);
        return {
            success: false,
            error: e
        };
    });

});

exports.likedPosts = functions.https.onCall((data, context) => {

    const offset = data.offset;
    const length = data.length;


    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    var queryParams = {
        facetFilters: [`userLikes:${uid}`],
        offset: offset,
        length: length
    }

    return postsIndex.search(queryParams).then(content => {
        var posts = [];
        for (var i = 0; i < content.hits.length; i++) {
            var post = content.hits[i];
            post['isYou'] = false;
            post['id'] = post['objectID'];
            posts.push(post);
        }

        return populatePosts(posts, uid);
    }).then(posts => {
        return {
            success: true,
            results: posts
        };
    }).catch(e => {
        console.log("Error: ", e);
        return {
            success: false,
            error: e
        };
    });

});

exports.timeoutsUpdater = functions.https.onRequest((req, res) => {
    const getUserTimeouts = firestore.collection('userTimeouts').where('canPost', '==', false).get();
    return getUserTimeouts.then(snapshot => {

        var promises = [];
        var timeout_MINS = 1;
        var timeout_MS = timeout_MINS * 60000;

        snapshot.forEach(function (timeout) {
            const uid = timeout.id;

            var timeoutData = timeout.data();
            var lastPostedAt = timeoutData.lastPostedAt;
            var diffMs = (Date.now() - lastPostedAt); // milliseconds between now & Christmas
            var diffMins = timeout_MINS - Math.round(((diffMs % 86400000) % 3600000) / 60000);

            if (diffMs > (timeout_MS)) {

                const setUserCanPost = firestore.collection('userTimeouts').doc(uid).set({
                    canPost: true
                });

                promises.push(setUserCanPost);

                let notifications = require('./notifications.js');
                let title = "Your new post is ready"
                let body = ""
                let sendNotification = notifications.sendNotification(admin, database, uid, title, body);
                promises.push(sendNotification);
            } else {
                const progress = diffMs / timeout_MS;

                const setUserTimerUpdate = firestore.collection('userTimeouts').doc(uid).update({
                    progress: progress,
                    minsLeft: diffMins
                });
                promises.push(setUserTimerUpdate);
            }
        });

        return promises;

    }).then(() => {
        return res.send({
            success: true
        });
    }).catch(e => {
        console.log("Error: ", e);
        return res.send({
            success: false
        });
    })
});

exports.tasksWorker = functions.https.onRequest((req, res) => {
    const getUpdatedPosts = database.ref(`posts/meta`).orderByChild('needsUpdate').equalTo(true).once('value');
    var postIDs = [];
    return getUpdatedPosts.then(results => {
        var promises = [];
        results.forEach(function (post) {
            const postID = post.key;
            const data = post.val();
            postIDs.push(postID);
            if (data.needsRemoval != null) {
                // Delete all post meta
                var updateObject = {};
                updateObject[`posts/commenters/${postID}`] = null;
                updateObject[`posts/likes/${postID}`] = null;
                updateObject[`posts/replies/${postID}`] = null;
                updateObject[`posts/reports/${postID}`] = null;
                updateObject[`posts/subscribers/${postID}`] = null;
                updateObject[`posts/meta/needsRemoval/${postID}`] = null;
                updateObject[`posts/meta/${postID}/removedAt`] = Date.now();
                promises.push(database.ref().update(updateObject));
            } else {
                const postRef = firestore.collection('posts').doc(postID);
                const metaObject = {
                    numLikes: data.numLikes != null ? data.numLikes : 0,
                    numReplies: data.numReplies != null ? data.numReplies : 0,
                    numCommenters: data.numCommenters != null ? data.numCommenters : 0,
                    reports: data.reports != null ? data.reports : 0,
                    score: 0
                };

                promises.push(postRef.update(metaObject));
            }
        });
        return Promise.all(promises);
    }).then(() => {
        var updateObject = {};
        for (var i = 0; i < postIDs.length; i++) {
            updateObject[`posts/meta/${postIDs[i]}/needsUpdate`] = null;
        }
        return database.ref().update(updateObject);
    }).then(() => {
        return res.send({
            success: true
        });
    }).catch(e => {
        console.log("Error: ", e);
        return res.send({
            success: false
        });
    })
});

//exports.calculatePostMeta = functions.database.ref('posts/meta/{postID}').onWrite((change, context) => {
//    const postID = context.params.postID;
//    const data = change.after.val();
//    const prevDataExists = change.before.exists();
//    var author;
//    var metaObject = {
//        score: 0,
//        numLikes: 0,
//        numReplies: 0,
//        reports: {
//            inappropriate: 0,
//            spam: 0
//        }
//    };
//
//    var numSubscribers = 0;
//
//    if (data != null) {
//        author = data.author;
//
//        if (data.numLikes != null) {
//            metaObject.numLikes = data.numLikes;
//        }
//
//        if (data.replies != null) {
//            metaObject.numReplies = data.replies;
//        }
//
//        if (data.subscribers != null) {
//            for (uid in data.subscribers) {
//                numSubscribers += 1;
//            }
//        }
//
//        const reports = data.reports;
//        if (reports != null) {
//            if (reports.inappropriate != null) {
//                metaObject.reports.inappropriate = reports.inappropriate;
//            }
//
//            if (reports.spam != null) {
//                metaObject.reports.spam = reports.spam;
//            }
//        }
//
//        metaObject.score = metaObject.numLikes + numSubscribers;
//    } else {
//        return Promise.resolve();
//    }
//
//    const postRef = firestore.collection('posts').doc(postID);
//
//    return postRef.update(metaObject).then(() => {
//        var searchMetaObject = metaObject;
//        searchMetaObject['objectID'] = postID;
//        const objects = [searchMetaObject];
//
//        if (data.author != null) {
//            if (data.parent != null) {
//                const updateSearchObject = commentsAdminIndex.partialUpdateObjects(objects, true);
//                return updateSearchObject;
//            } else {
//                const updateSearchObject = postsAdminIndex.partialUpdateObjects(objects, true);
//                return updateSearchObject;
//            }
//        } else {
//            return Promise.resolve();
//        }
//
//    }).catch(e => {
//        console.log("Error: ", e);
//        return Promise.resolve();
//    })
//});

exports.updatePostLikes = functions.database.ref('posts/likes/{postID}/{uid}').onWrite((change, context) => {
    const postID = context.params.postID;
    const uid = context.params.uid;

    const prevData = change.before.val();
    const data = change.after.val();
    var newCount = 0;
    if (data != null) {
        newCount = data ? 1 : -1;
    } else if (prevData != null) {
        newCount = prevData ? -1 : 0;
    }


    var promise = Promise.resolve();

    if (newCount != 0) {
        const postLikesRef = database.ref(`posts/meta/${postID}/numLikes`);
        promise = postLikesRef.transaction(function (numLikes) {
            if (numLikes) {
                numLikes += newCount;
            } else {
                numLikes = newCount;
            }
            return numLikes;
        });
    }

    return promise.then(() => {
        const setNeedsUpdate = database.ref(`posts/meta/${postID}/needsUpdate`).set(true);
        return setNeedsUpdate;
    });
});

exports.updatePostReplies = functions.database.ref('posts/replies/{postID}/{replyID}').onWrite((change, context) => {
    const postID = context.params.postID;

    const prevData = change.before.val();
    const data = change.after.val();
    var newCount = data != null ? 1 : -1;

    const postRepliesRef = database.ref(`posts/meta/${postID}/numReplies`);
    return postRepliesRef.transaction(function (numReplies) {
        if (numReplies) {
            numReplies += newCount;
        } else {
            numReplies = newCount;
        }
        return numReplies;
    }).then(() => {
        const setNeedsUpdate = database.ref(`posts/meta/${postID}/needsUpdate`).set(true);
        return setNeedsUpdate;
    });
});

exports.updatePostCommenters = functions.database.ref('posts/commenters/{postID}/{uid}').onWrite((change, context) => {
    const postID = context.params.postID;

    const prevData = change.before.val();
    const data = change.after.val();
    var newCount = data != null ? 1 : -1;

    const postRepliesRef = database.ref(`posts/meta/${postID}/numCommenters`);
    return postRepliesRef.transaction(function (numCommenters) {
        if (numCommenters) {
            numCommenters += newCount;
        } else {
            numCommenters = newCount;
        }
        return numCommenters;
    }).then(() => {
        const setNeedsUpdate = database.ref(`posts/meta/${postID}/needsUpdate`).set(true);
        return setNeedsUpdate;
    });
});

exports.updatePostReports = functions.database.ref('posts/reports/{postID}/{uid}').onWrite((change, context) => {
    const postID = context.params.postID;
    const uid = context.params.uid;

    const prevData = change.before.val();
    const data = change.after.val();

    var inappropriateCount = 0;
    var spamCount = 0;

    if (data != null) {
        const type = data.type;
        switch (type) {
            case "inappropriate":
                inappropriateCount = 1;
                break;
            case "spam":
                spamCount = 1;
                break;
            default:
                break;
        }
    }

    if (prevData != null) {
        const prevType = prevData.type;
        switch (prevType) {
            case "inappropriate":
                inappropriateCount -= 1;
                break;
            case "spam":
                spamCount -= 1;
                break;
            default:
                break;
        }
    }

    const postReportsRef = database.ref(`posts/meta/${postID}/reports`);
    return postReportsRef.transaction(function (reports) {
        if (reports) {
            reports.inappropriate += inappropriateCount;
            reports.spam += spamCount;
        } else {
            reports = {
                inappropriate: inappropriateCount,
                spam: spamCount
            };
        }
        return reports;
    }).then(() => {
        const setNeedsUpdate = database.ref(`posts/meta/${postID}/needsUpdate`).set(true);
        return setNeedsUpdate;
    });
});

//exports.updatePostLikes = functions.database.ref('posts/likes/{postID}/{uid}').onWrite((change, context) => {
//
//    const prevDataExists = change.before.exists();
//
//    const postID = context.params.postID;
//    const uid = context.params.uid;
//
//    const getPost = firestore.collection('posts').doc(postID).get();
//
//    var postData = null;
//    var result = null;
//    return getPost.then(snapshot => {
//
//        postData = snapshot.data();
//        if (postData == null) {
//            return Promise.reject();
//        }
//
//        var promise = Promise.resolve();
//        if (!prevDataExists) {
//            promise = database.ref(`posts/meta/${postID}`).once('value');
//        }
//        return promise;
//    }).then(_result => {
//        result = _result;
//        return anonymizer.getUserAnonymousKey(uid, postID);
//    }).then(anonObject => {
//        if (result != null && result != undefined) {
//            const author = result.val().author;
//            const subscribers = result.val().subscribers;
//
//            if (author === uid) {
//                return Promise.resolve();
//            }
//            if (subscribers != undefined && subscribers != null) {
//                if (!subscribers.hasOwnProperty(author)) {
//                    return Promise.resolve();
//                }
//            } else {
//                
//                // No subscribers
//                return Promise.resolve();
//            }
//            var numLikes = 0;
//            if (result.val().numLikes) {
//                numLikes = result.val().numLikes;
//            }
//
//            const notificationID = `POST_LIKES:${postID}`
//            const notificationObject = {
//                anon: anonObject,
//                timestamp: Date.now(),
//                type: "POST_LIKES",
//                numLikes: numLikes + 1,
//                postID: postID,
//                seen: false,
//                text: trim(postData.textClean)
//            };
//            const notificationsRef = database.ref(`users/notifications/${author}/${notificationID}`);
//
//            notificationsRef.set(null).then(() => {
//                return notificationsRef.set(notificationObject);
//            }).catch(e => {
//                return notificationsRef.set(notificationObject);
//            })
//        } else {
//            return Promise.resolve();
//        }
//    }).then(() => {
//        const addTask = database.ref(`tasks/posts/${postID}/likes`).set(true);
//        return addTask;
//    }).catch(e => {
//        console.log("Error: ", e);
//        return Promise.reject(e);
//    });
//});


exports.sendUserNotification = functions.database.ref('users/notifications/{uid}/{notificationID}').onWrite((change, context) => {
    var uid = context.params.uid;
    var notificationID = context.params.notificationID;

    const beforeData = change.before.val(); // data before the write
    const data = change.after.val();



    if (data == undefined || data == null) {
        console.log("Notification -> Deleted");
        return null;
    }

    if (beforeData != undefined && beforeData != null) {
        if (beforeData.timestamp == data.timestamp) {
            console.log("Notification -> Not a significant update");
            return null
        }
    }

    var title = null;
    var body = null;

    switch (data.type) {
        case "POST_LIKES":
            title = "Someone liked your post.";
            body = `${data.text}`;
            break;
        case "POST_REPLY":
            title = `${data.name}`;
            body = `${data.text}`;
            break;
        default:
            break;
    };

    if (body == null || title == null) {
        return null;
    }

    let notifications = require('./notifications.js');
    return notifications.sendNotification(admin, database, uid, title, body);
});


exports.removePost = functions.https.onCall((data, context) => {
    // Message text passed from the client.
    const postID = data.postID;
    // Authentication / user information is automatically added to the request.
    const uid = context.auth.uid;

    // Checking that the user is authenticated.
    if (!context.auth) {
        // Throwing an HttpsError so that the client gets the error details.
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    }

    const getAuthor = database.ref(`posts/meta/${postID}`).once('value');
    return getAuthor.then(result => {
        const author = result.val().author;
        const parent = result.val().parent;

        if (author != uid) {
            throw new functions.https.HttpsError('failed-precondition', 'User is not authoried to delete this post.');
        }


        if (parent != null && parent != "NONE") {
            const updateObject = {
                "deleted": true,
                "text": "",
                "textClean": "",
                "anon": {
                    "adjective": "",
                    "animal": "",
                    "color": "",
                    "key": ""
                }
            }

            const updateComment = firestore.collection("posts").doc(postID).update(updateObject);
            return updateComment.then(() => {
                const deleteIndexObject = commentsAdminIndex.deleteObject(postID);
                return deleteIndexObject;
            }).then(() => {

                const getSubscribers = database.ref(`posts/subscribers/${parent}`).once('value');
                return getSubscribers;

            }).then(_subscribers => {
                var subscribers = _subscribers.val();
                var promises = [];
                for (var subscriberID in subscribers) {
                    const getPostNotifications = database.ref(`users/notifications/${subscriberID}`)
                        .orderByChild('replyID')
                        .equalTo(postID)
                        .once('value');
                    promises.push(getPostNotifications);
                }

                return Promise.all(promises.map(promiseReflect));
            }).then(results => {
                var promises = [];
                for (var i = 0; i < results.length; i++) {
                    var result = results[i];
                    const status = result["status"];
                    const snapshot = result["data"];
                    if (snapshot != null && status == "resolved") {
                        var replies = [];
                        snapshot.forEach(function (notification) {
                            const promise = database.ref(`users/notifications/${snapshot.key}/${notification.key}`).remove();
                            promises.push(promise);
                        });
                    }
                }
                return Promise.all(promises.map(promiseReflect));
            }).catch(e => {
                console.log("Error: ", e);
                return Promise.resolve();
            });
        } else {
            const removePostObject = {
                "removedAt": Date.now(),
                "status": 'removed'
            };
            const markPostForRemoval = firestore.collection("posts").doc(postID).set(removePostObject);
            return markPostForRemoval;
        }


    }).then(() => {
        return {
            success: true
        }
    }).catch(e => {
        return {
            success: false,
            msg: e
        }
    });
});

exports.decimatePost = functions.firestore.document('posts/{postID}').onDelete((change, context) => {
    const postID = context.params.postID;
    const deletePostMeta = database.ref(`posts/meta/${postID}`).remove();
    return deletePostMeta;
});

exports.updatePost = functions.firestore.document('posts/{postID}').onUpdate((change, context) => {
    const postID = context.params.postID;
    const data = change.after.data();

    const prevData = change.before.data();

    if (data != null && data.status === 'removed') {

        var uid;
        var batchSize = 20;

        const getMeta = database.ref(`posts/meta/${postID}`).once('value');
        return getMeta.then(result => {
            uid = result.val().author;

            const fileDeletions = [
                    deleteFile(`publicPosts/${postID}/video.mp4`),
                    deleteFile(`publicPosts/${postID}/thumbnail.gif`),
                    deleteFile(`publicPosts/${postID}/thumbnail.jpg`),
                    deleteFile(`userPosts/${uid}/${postID}/video.mp4`),
                    deleteFile(`userPosts/${uid}/${postID}/thumbnail.gif`),
                    deleteFile(`userPosts/${uid}/${postID}/thumbnail.jpg`)
                ];

            return Promise.all(fileDeletions.map(promiseReflect));
        }).then(() => {
            const deleteIndexObject = postsAdminIndex.deleteObject(postID);
            return deleteIndexObject;
        }).then(() => {
            const getSubscribers = database.ref(`posts/subscribers/${postID}`).once('value');
            return getSubscribers;
        }).then(_subscribers => {
            var subscribers = _subscribers.val();
            var promises = [];
            for (var subscriberID in subscribers) {
                const getPostNotifications = database.ref(`users/notifications/${subscriberID}`).orderByChild('postID').equalTo(postID).once('value');
                promises.push(getPostNotifications);
            }

            return Promise.all(promises.map(promiseReflect));
        }).then(results => {
            var promises = [];
            for (var i = 0; i < results.length; i++) {
                var result = results[i];
                const status = result["status"];
                const snapshot = result["data"];
                if (status == "resolved" && snapshot != undefined && snapshot != null) {
                    var replies = [];
                    snapshot.forEach(function (notification) {
                        const promise = database.ref(`users/notifications/${snapshot.key}/${notification.key}`).remove();
                        promises.push(promise);
                    });
                }
            }
            return Promise.all(promises.map(promiseReflect));
        }).then(() => {
            var updateObject = {};
            updateObject[`posts/meta/${postID}/needsUpdate`] = true;
            updateObject[`posts/meta/${postID}/needsRemoval`] = true;
            return database.ref().update(updateObject);
        }).then(() => {

            const repliesRef = firestore.collection('posts').where('status', '==', 'active').where('parent', '==', postID)
            const repliesQuery = repliesRef.orderBy('createdAt').limit(batchSize);
            return new Promise((resolve, reject) => {
                markQueryBatchForRemoval(firestore, repliesQuery, batchSize, resolve, reject);
            });

        }).then(() => {
            var lexiconRef = firestore.collection('posts').doc(postID).collection('lexicon');
            var query = lexiconRef.orderBy('key').limit(batchSize);
            return new Promise((resolve, reject) => {
                deleteQueryBatch(firestore, query, batchSize, resolve, reject);
            });
        }).then(() => {
            return Promise.resolve();
        }).catch(e => {
            console.log("Error: ", e);
            return Promise.reject();
        })

    } else {
        
        var metaObject = {
            numLikes: data.numLikes != null ? data.numLikes : 0,
            numReplies: data.numReplies != null ? data.numReplies : 0,
            numCommenters: data.numCommenters != null ? data.numCommenters : 0,
            reports: data.reports != null ? data.reports : 0,
            score: 0
        };
        metaObject['objectID'] = postID;
        console.log("UPDATE ALGOLIA! ", metaObject);
        const objects = [metaObject];
        
        if (data.parent != null && data.parent != 'NONE') {
            return commentsAdminIndex.partialUpdateObjects(objects, true);
        } else {
            return postsAdminIndex.partialUpdateObjects(objects, true);
        }
    }
});

function deleteFile(filePath) {
    return new Promise((resolve, reject) => {
        const bucket = admin.storage().bucket();
        const file = bucket.file(filePath);
        return file.delete().then(() => {
            return resolve();
        }).catch(err => {
            return reject(err);
        });
    });
};

function markQueryBatchForRemoval(db, query, batchSize, resolve, reject) {
    query.get()
        .then((snapshot) => {
            // When there are no documents left, we are done
            if (snapshot.size == 0) {
                return 0;
            }


            const deletedPostObject = {
                "status": "removed",
                "removedAt": Date.now()
            };
            // Delete documents in a batch
            var batch = db.batch();
            snapshot.docs.forEach((doc) => {
                batch.set(doc.ref, deletedPostObject);
            });

            return batch.commit().then(() => {
                return snapshot.size;
            });
        }).then((numDeleted) => {
            if (numDeleted === 0) {
                resolve();
                return;
            }

            // Recurse on the next process tick, to avoid
            // exploding the stack.
            process.nextTick(() => {
                markQueryBatchForRemoval(db, query, batchSize, resolve, reject);
            });
        })
        .catch(reject);
}

function deleteQueryBatch(db, query, batchSize, resolve, reject) {
    query.get()
        .then((snapshot) => {
            // When there are no documents left, we are done
            if (snapshot.size == 0) {
                return 0;
            }

            // Delete documents in a batch
            var batch = db.batch();
            snapshot.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });

            return batch.commit().then(() => {
                return snapshot.size;
            });
        }).then((numDeleted) => {
            if (numDeleted === 0) {
                resolve();
                return;
            }

            // Recurse on the next process tick, to avoid
            // exploding the stack.
            process.nextTick(() => {
                deleteQueryBatch(db, query, batchSize, resolve, reject);
            });
        })
        .catch(reject);
}

function extractMentions(text) {
    const pattern = /\B@[a-z0-9_-]+/gi;
    let results = text.match(pattern);

    return results != null ? results : [];
}

function trim(string) {
    var length = 100;
    var str = string;
    var trimmedString = str.length > length ? str.substring(0, length - 3) + "..." : str;

    return str;
}
