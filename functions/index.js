//const root = require('./root.js');
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
var decay = require('decay');
var hackerHotScore = decay.hackerHot();

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
const groupsAdminIndex = algolia.initIndex('groups');

const popularPostsIndex = algolia_client.initIndex('popularPosts');
const postsIndex = algolia_client.initIndex('posts');
const commentsIndex = algolia_client.initIndex('comments');
const groupsIndex = algolia.initIndex('groups');


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

exports.saveAllAnonymousNames = functions.https.onRequest((req, res) => {

	return anonymizer.systemSaveAllAnonNames(firebase.systemDatabase()).then(() => {
		return res.send({
			success: true
		});
	}).catch(e => {
		console.log("Error: ", e);
		return res.send({
			success: false
		});
	});

});

exports.cleanUp = functions.https.onRequest((req, res) => {

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

exports.randomizeUserGradient = functions.https.onCall((data, context) => {
	const uid = context.auth.uid;
	// Checking that the user is authenticated.
	if (!context.auth) {
		// Throwing an HttpsError so that the client gets the error details.
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}
	const randomGradient = anonymizer.matchingGradient();
	const setGradient = database.child(`users/profile/${uid}/gradient`).set(randomGradient);
	return setGradient.then(() => {
		return {
			success: true,
			gradient: randomGradient
		}
	}).catch(e => {
		console.log("Error: ", e);
		return {
			success: false,
			error: e
		}
	})
});

exports.trendingTags = functions.https.onCall((data, context) => {
	const uid = context.auth.uid;

	// Checking that the user is authenticated.
	if (!context.auth) {
		// Throwing an HttpsError so that the client gets the error details.
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}

	const getTrendingTags = database.child(`trending/hashtags`).once('value');
	return getTrendingTags.then(snapshot => {
		var trendingData = snapshot.val();
		snapshot.forEach(function (tag) {
			const data = tag.val();
			const posts = data.posts;
			var postsArray = [];
			for (var key in posts) {
				var post = posts[key];
				post['isYou'] = post.uid === uid;
				delete post.uid;
				postsArray.push(post);
			}
			trendingData[tag.key]['posts'] = postsArray;
		});

		return trendingData;
	});
});

exports.calculateTrending = functions.https.onRequest((req, res) => {

	var now = new Date();
	var oneWeekAgo = Date.now() - (60 * 60 * 24 * 7 * 1000);

	const getAllFacets = postsAdminIndex.search({
		facets: ['group'],
		maxValuesPerFacet: 10,
		numericFilters: `createdAt > ${oneWeekAgo}`
	});

	var trendingHashtags = [];

	return getAllFacets.then(results => {
		var promises = [];

		console.log("RESULTS!: ", results);
		if (results.facets) {
			if (results.facets.group) {

				const groups = results.facets.group;
				console.log("GROUPS: ", groups);
				for (var group in groups) {
					trendingHashtags.push({
						tag: group,
						count: groups[group]
					});

					const getTopPostForTag = popularPostsAdminIndex.search({
						facetFilters: [`group:${group}`],
						offset: 0,
						length: 5
					});
					promises.push(getTopPostForTag);
				}
			}
		}

		return Promise.all(promises);

	}).then(topResults => {
		console.log(`TOP RESULTS: ${util.inspect(topResults, false, null)}`);
		var trendingObject = {};
		for (var i = 0; i < topResults.length; i++) {
			const result = topResults[i];
			var posts = [];

			for (var j = 0; j < result.hits.length; j++) {
				var hit = result.hits[j];
				hit.id = hit.objectID;
				delete hit.objectID;
				delete hit._geoloc;
				delete hit._highlightResult;
				posts.push(hit);
			}

			const trendingHashtag = trendingHashtags[i];

			trendingObject[trendingHashtag.tag] = {
				count: trendingHashtag.count,
				posts: posts
			}
		}

		const setTrendingHashtags = database.child(`trending/hashtags`).set(trendingObject);
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

	const createdAt = Date.now();
	const timeoutRef = database.child(`users/timeout/${uid}`);
	return timeoutRef.once('value').then(result => {
		const data = result.val();
		if (data.canPost == true) {

			var userObject = {
				lastPostedAt: createdAt,
				canPost: false,
				progress: 0
			};

			// DELETE ME
			userObject = {
				canPost: true
			};

			return timeoutRef.set(userObject);
		} else {
			return Promise.reject();
		}
	}).then(() => {

		const postObject = {
			"status": "pending",
			"createdAt": createdAt
		};
		const addPostDoc = firestore.collection('posts').add(postObject);

		return addPostDoc;


	}).then(ref => {
		return {
			"success": true,
			"postID": ref.id
		};
	}).catch(e => {
		console.log("Error: ", e);
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
	const email_verified = context.auth.token.email_verified;

	// Checking that the user is authenticated.
	if (!context.auth) {
		// Throwing an HttpsError so that the client gets the error details.
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}

	if (email == null || !email_verified) {
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}

	const createdAt = Date.now();


	var postObject;
	var anonObject;
	var profileObject;
	var lat;
	var lon;
	var region;
	var location;

	const postID = data.postID;
	const text = data.text;
	const group = data.group;
	const attachments = data.attachments;
	const isAnonymous = data.isAnonymous;
	const gradient = anonymizer.matchingGradient();

	const thumbnailJPGInputFilePath = `/userPosts/${uid}/${postID}/thumbnail.jpg`;
	const thumbnailJPGOutputFilePath = `publicPosts/${postID}/thumbnail.jpg`;

	var getUserProfile = Promise.resolve(null);

	if (!isAnonymous) {
		getUserProfile = database.child(`users/profile/${uid}`).once('value');

	}


	return getUserProfile.then(_profile => {

		if (!isAnonymous) {
			if (_profile == null) {
				return Promise.reject("Invalid user profile");
			} else {
				profileObject = _profile.val();
			}

		}

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
		return Promise.all(anonymizeFiles)
	}).then(() => {

		postObject = {
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

		if (group) {
			postObject['group'] = group;
		}

		if (isAnonymous) {

			const adjective = anonymizer.randomAdjective();
			const animal = anonymizer.randomAnimal();
			const color = anonymizer.randomColor();

			const anonKey = `${adjective}${animal}`.toLowerCase();

			location = data.location;
			anonObject = {
				"key": anonKey,
				"adjective": adjective,
				"animal": animal,
				"color": color
			};

			postObject['anon'] = anonObject;

		} else {
			profileObject['key'] = profileObject['username'].toLowerCase();
			postObject['author'] = uid;
			postObject['profile'] = profileObject;

		}

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

		var metaObject = {
			author: uid,
			status: 'active',
			createdAt: createdAt
		};

		var updateObject = {};
		updateObject[`posts/subscribers/${postID}/${uid}`] = true
		updateObject[`posts/meta/${postID}`] = metaObject;

		if (isAnonymous) {
			updateObject[`posts/lexicon/${postID}/${uid}`] = anonObject;
		} else {
			updateObject[`posts/lexicon/${postID}/${uid}`] = profileObject;
		}

		const setPostMeta = database.update(updateObject);
		return setPostMeta;

	}).then(() => {
		if (group) {
			var groupRef = firestore.collection('groups').doc(group);
			var transaction = firestore.runTransaction(t => {
				return t.get(groupRef)
					.then(doc => {
						// Add one person to the city population
						var newNumPosts = 1;
						if (doc.data().numPosts != null) {
							newNumPosts = doc.data().numPosts + 1;
						}

						t.update(groupRef, {
							numPosts: newNumPosts
						});
					});
			});

			return transaction;
		} else {
			return Promise.resolve();
		}
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
	const isAnonymous = data.isAnonymous;

	const textClean = swearjar.censor(text);
	const replyTo = data.replyTo;

	const parentPostRef = firestore.collection('posts').doc(postID);

	var anonObject = {};

	var commentObject = {};

	var replyID;
	var postAuthor;
	var lexiconEntry = null;
	var subscribers = {};
	var createdAt = Date.now();

	const getPostMeta = database.child(`posts/meta/${postID}`).once('value');
	return getPostMeta.then(result => {
		if (result.exists()) {
			const postMeta = result.val()
			postAuthor = postMeta.author;

			return anonymizer.getUserLexiconEntry(uid, postID, isAnonymous);

		} else {
			throw new functions.https.HttpsError('failed-precondition', 'Unable to add comment.');
		}
	}).then(_lexiconEntry => {
		lexiconEntry = _lexiconEntry

		commentObject = {
			"text": text,
			"textClean": textClean,
			"createdAt": createdAt,
			"parent": postID,
			"status": "active",
			"numReplies": 0,
			"hashtags": findHashtags(text),
			"votes": 0,
			"score": 0
		};

		if (lexiconEntry != null) {
			if (isAnonymous) {
				if (lexiconEntry.key != null && lexiconEntry.adjective != null &&
					lexiconEntry.animal != null && lexiconEntry.color != null) {
					commentObject['anon'] = lexiconEntry;
				} else {
					return Promise.reject('Invalid anon object');
				}
			} else {
				if (lexiconEntry.username != null) {
					commentObject['author'] = uid;
					commentObject['profile'] = lexiconEntry;
				} else {
					return Promise.reject('Invalid profile object');
				}
			}
		} else {
			return Promise.reject('Invalid lexicon entry');
		}

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
		updateObject[`posts/meta/${replyID}/status`] = 'active';
		updateObject[`posts/meta/${replyID}/createdAt`] = createdAt;
		updateObject[`posts/meta/${replyID}/parent`] = postID;

		updateObject[`posts/replies/${postID}/${replyID}`] = true;
		updateObject[`posts/commenters/${postID}/${uid}`] = true;
		updateObject[`posts/subscribers/${postID}/${uid}`] = true;

		if (replyTo) {
			updateObject[`posts/replies/${replyTo}/${replyID}`] = true;
			updateObject[`posts/commenters/${replyTo}/${replyID}`] = true;
		}

		const update = database.update(updateObject);
		return update;
	}).then(() => {
		var record = commentObject;

		record.uid = uid;

		record.objectID = replyID;
		return commentsAdminIndex.saveObject(record);

	}).then(() => {

		const getSubscribers = database.child(`posts/subscribers/${postID}`).once('value');
		return getSubscribers;
	}).then(_subscribers => {

		subscribers = _subscribers.val();
		const mentions = extractMentions(text);

		var mentionedUIDs = {};

		var promises = [];

		for (var i = 0; i < mentions.length; i++) {
			const mention = mentions[i].substring(1);
			const getLexiconEntry = database.child(`posts/lexicon/${postID}`).orderByChild('key').equalTo(mention).once('value');
			promises.push(getLexiconEntry);
		}

		return Promise.all(promises);

	}).then(entriesArray => {

		var mentionedUIDs = {};

		for (var r = 0; r < entriesArray.length; r++) {
			const entries = entriesArray[r];
			entries.forEach(function (entry) {
				console.log(`Entry ${entry.key} = ${entry.val()}`);
				mentionedUIDs[entry.key] = true;
			});
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
					timestamp: Date.now(),
					type: "POST_REPLY",
					postID: postID,
					replyID: replyID,
					mention: subscriberID in mentionedUIDs,
					seen: false,
					text: trim(textClean)
				};

				if (isAnonymous) {
					notificationObject['anon'] = lexiconEntry;
					notificationObject['name'] = `${lexiconEntry.adjective}${lexiconEntry.animal}`;
				} else {
					notificationObject['profile'] = lexiconEntry;
					notificationObject['name'] = lexiconEntry.username;
				}

				if (replyTo) {
					notificationObject["replyTo"] = replyTo;
				}

				const notificationsRef = database.child(`users/notifications/${subscriberID}`).push();
				const setNotification = notificationsRef.set(notificationObject);

				notificationPromises.push(setNotification);
			}
		}

		return Promise.all(notificationPromises.map(promiseReflect));
	}).then(() => {

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


exports.createGroup = functions.https.onCall((data, context) => {

	// Authentication / user information is automatically added to the request.
	const uid = context.auth.uid;
	const email = context.auth.token.email;
	const email_verified = context.auth.token.email_verified;

	// Checking that the user is authenticated.
	if (!context.auth) {
		// Throwing an HttpsError so that the client gets the error details.
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}

	if (email == null || !email_verified) {
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}

	const createdAt = Date.now();

	const name = data.name;
	const desc = data.desc;
	const avatarURL_low = data.avatar.low;
	const avatarURL_high = data.avatar.high;

	const groupObject = {
		"createdAt": createdAt,
		"name": name,
		"desc": desc,
		"avatar": {
			"low": avatarURL_low,
			"high": avatarURL_high
		},
		"numMembers": 1
	}

	const addGroup = firestore.collection('groups').add(groupObject);

	var docID;
	return addGroup.then(doc => {
		docID = doc.id;

		const joinGroupObject = {};
		joinGroupObject[`groups/members/${docID}/${uid}`] = true;
		joinGroupObject[`users/groups/${uid}/${docID}`] = true;
		const joinGroup = database.update(joinGroupObject);
		return joinGroup;

	}).then( () => {
		var indexObject = groupObject;
		indexObject['creator'] = uid;
		return groupsAdminIndex.saveObject(indexObject);
	}).then(() => {
		return {
			success: true,
			group: {
				id: docID,
				data: groupObject
			}
		}
	}).catch(e => {
		console.log("Error: ", e);
		return {
			success: false
		}
	})

});

exports.groupUpdateMembers = functions.database.ref('app/groups/members/{groupID}/{uid}').onWrite((change, context) => {
	const groupID = context.params.groupID;
	const uid = context.params.uid;

	const prevData = change.before.val();
	const data = change.after.val();
	var newCount = 0;

	if (data != null) {
		newCount = data ? 1 : -1;
	} else if (prevData != null) {
		newCount = prevData ? -1 : 0;
	}

	if (newCount == 0) {
		return null;
	}

	var groupRef = firestore.collection('groups').doc(groupID);
	var transaction = firestore.runTransaction(t => {
		return t.get(groupRef)
			.then(doc => {
				// Add one person to the city population
				var newNumMembers = newCount;
				if (doc.data().numMembers != null) {
					newNumMembers = doc.data().numMembers + newCount;
				}

				t.update(groupRef, {
					numMembers: newNumMembers
				});
			});
	});

	return transaction;

});

function populatePosts(_posts, uid) {
	return new Promise((resolve, reject) => {
		var posts = _posts;
		var promises = [];

		for (var i = 0; i < posts.length; i++) {
			const post = posts[i];
			if (post.profile != null) {
				promises.push(null);
			} else {
				const getPostAuthor = database.child(`posts/meta/${post.id}/author`).once('value');
				promises.push(getPostAuthor);
			}

		}
		return Promise.all(promises).then(results => {
			for (var i = 0; i < results.length; i++) {
				const result = results[i];
				if (result != null) {
					posts[i]['isYou'] = result.val() === uid;
				}
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

		const getMyLexiconEntry = database.child(`posts/lexicon/${postID}/${uid}`).once('value');
		var lexiconKey = "";

		getMyLexiconEntry.then(entry => {
			if (entry.exists()) {
				if (entry.val().key) {
					lexiconKey = entry.val().key;
				}
			}
			return query;
		}).then(snapshot => {
			var promises = [];
			snapshot.forEach(function (comment) {
				var commentData = comment.data();
				commentData['id'] = comment.id;

				if (commentData.anon != null) {
					commentData['isYou'] = commentData.anon.key === lexiconKey;
				}

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

					subReplyData['id'] = subReply.id;

					if (subReplyData.anon != null) {
						subReplyData['isYou'] = subReplyData.anon.key === lexiconKey;
					}

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

exports.createUserProfile = functions.https.onCall((data, context) => {

	const uid = context.auth.uid;

	// Checking that the user is authenticated.
	if (!context.auth) {
		// Throwing an HttpsError so that the client gets the error details.
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}

	const username = data.username;

	if (!username.isAlphaNumeric()) {
		throw new functions.https.HttpsError('failed-precondition', 'Username must contain only letters and numbers.');
	}

	if (username.length < 6) {
		throw new functions.https.HttpsError('failed-precondition', 'Username must be at least 6 characters.');
	}

	if (username.length > 20) {
		throw new functions.https.HttpsError('failed-precondition', 'Username must be less than 20 characters.');
	}


	var profile = {
		username: username,
		gradient: anonymizer.matchingGradient(),
		uid: uid
	};

	const usernameKey = username.toLowerCase();
	const getAnonEntry = firebase.systemDatabase().child(`anon/names/${usernameKey}`).once('value');

	const usernameEntryRef = database.child(`users/usernames/${usernameKey}`);
	var promises = [
		usernameEntryRef.once('value'),
		getAnonEntry
	];

	return Promise.all(promises).then(results => {
		const anonEntry = results[0];
		const usernameEntry = results[1];
		if (anonEntry.exists() || usernameEntry.exists()) {
			return Promise.reject('Username is taken.');
		}

		const getUserProfile = database.child(`users/profile/${uid}`).once('value');
		return getUserProfile;

	}).then(profile => {
		if (profile.exists()) {
			if (profile.val().username != null) {
				return Promise.reject('User profile already exists');
			}
		}

		return usernameEntryRef.set(uid);
	}).then(() => {
		const userRef = database.child(`users/profile/${uid}`)
		return userRef.set(profile)
	}).then(() => {
		return {
			success: true,
			profile: profile
		}
	}).catch(e => {
		console.log("Error: ", e);
		throw new functions.https.HttpsError('failed-precondition', e);
	})

});

exports.skipCreateProfile = functions.https.onCall((data, context) => {

	const uid = context.auth.uid;

	// Checking that the user is authenticated.
	if (!context.auth) {
		// Throwing an HttpsError so that the client gets the error details.
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}

	const setSkip = database.child(`users/profile/${uid}/skipCreateProfile`).set(true);
	return setSkip.then(() => {
		return {
			success: true
		}
	})

});

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
		var settings = {};
		var groups = {};
		var groupsSkipped = {};
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
			const timeoutRef = database.child(`users/timeout/${uid}`);
			if (isReturningUser) {
				return timeoutRef.once('value');
			} else {
				return timeoutRef.set(timeoutObject);
			}

		}).then(snapshot => {
			if (isReturningUser) {
				timeoutObject = snapshot.val();
			}
			const getUserSettings = database.child(`users/settings/${uid}`).once('value');
			return getUserSettings;
		}).then(snapshot => {
			settings = snapshot.val() != null ? snapshot.val() : {};
			const getUserGroups = database.child(`users/groups/${uid}`).once('value');
			return getUserGroups;
		}).then(snapshot => {
			groups = snapshot.val() != null ? snapshot.val() : {};
			const getUserGroups = database.child(`users/groupsSkipped/${uid}`).once('value');
			return getUserGroups;
		}).then(snapshot => {
			groupsSkipped = snapshot.val() != null ? snapshot.val() : {};
			const getUserProfile = database.child(`users/profile/${uid}`).once('value');
			return getUserProfile;
		}).then(snapshot => {
			return {
				success: true,
				type: "email",
				settings: settings,
				timeout: timeoutObject,
				groups: groups,
				groupsSkipped: groupsSkipped,
				profile: snapshot.val() != null ? snapshot.val() : {}
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

exports.recentGroupPosts = functions.https.onCall((data, context) => {

	const offset = data.offset;
	const limit = data.limit;
	const groupID = data.groupID;

	// Authentication / user information is automatically added to the request.
	const uid = context.auth.uid;

	// Checking that the user is authenticated.
	if (!context.auth) {
		// Throwing an HttpsError so that the client gets the error details.
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}

	const rootPostsRef = firestore.collection('posts').where('status', '==', 'active')
		.where('parent', '==', 'NONE')
		.where('group', '==', groupID);

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

exports.myFeedPosts = functions.https.onCall((data, context) => {

	const offset = data.offset;
	const length = data.length;
	const groups = data.groups;
	const before = data.before;


	// Authentication / user information is automatically added to the request.
	const uid = context.auth.uid;

	// Checking that the user is authenticated.
	if (!context.auth) {
		// Throwing an HttpsError so that the client gets the error details.
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}

	var facetFilters = [];
	for (var group in groups) {
		
		facetFilters.push(`group:${group}`);
	}

	var queryParams;
	queryParams = {
		facetFilters: [facetFilters]
	};
	
	if (before) {
		queryParams['numericFilters'] = `createdAt > ${before}`;
	} else {
		queryParams['offset'] = offset;
		queryParams['length'] = length;
	}
	
	console.log("QUERY PARAMS: ", queryParams);

	return postsIndex.search(queryParams).then(content => {
		var posts = [];
		for (var i = 0; i < content.hits.length; i++) {
			var post = content.hits[i];
			post['isYou'] = false;
			post['id'] = post['objectID'];
			posts.push(post);
		}
		
		console.log("FEED RESULTS: ", content.hits);

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

	return postsAdminIndex.search(queryParams).then(content => {
		var posts = [];
		for (var i = 0; i < content.hits.length; i++) {
			var post = content.hits[i];
			post['isYou'] = false;
			post['id'] = post['objectID'];

			const geoLoc = post['_geoloc'];
			if (geoLoc) {
				const geoLat = geoLoc['lat'];
				const geoLng = geoLoc['lng'];
				if (geoLat != null && geoLng != null) {
					const distance = utilities.haversineDistance(lat, lng, geoLat, geoLng);
					post['distance'] = distance;
				}
			}
			posts.push(post);
		}

		console.log("NEARBY POSTS: ", posts);


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
			post['isYou'] = post.anon != null;
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

			post['isYou'] = post.anon != null;
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

exports.userPosts = functions.https.onCall((data, context) => {

	const username = data.username;
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
		facetFilters: [`profile.key:${username.toLowerCase()}`],
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

		console.log("POSTS: ", posts);

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

exports.userComments = functions.https.onCall((data, context) => {

	const username = data.username;
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
		facetFilters: [`profile.key:${username.toLowerCase()}`],
		offset: offset,
		length: length
	}

	return commentsIndex.search(queryParams).then(content => {
		var posts = [];
		for (var i = 0; i < content.hits.length; i++) {
			var post = content.hits[i];

			post['isYou'] = false;
			post['id'] = post['objectID'];
			posts.push(post);
		}

		return populateComments(posts, uid);
	}).then(posts => {
		console.log(`COMMENTS: ${posts}`);
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
	const getTimeouts = database.child(`users/timeout`).orderByChild('canPost').equalTo(false).once('value');
	return getTimeouts.then(snapshot => {

		var promises = [];
		var timeout_MINS = 1;
		var timeout_MS = timeout_MINS * 60000;

		snapshot.forEach(function (timeout) {
			const uid = timeout.key;

			var timeoutData = timeout.val();
			var lastPostedAt = timeoutData.lastPostedAt;
			var diffMs = (Date.now() - lastPostedAt); // milliseconds between now & Christmas
			var diffMins = timeout_MINS - Math.round(((diffMs % 86400000) % 3600000) / 60000);

			if (diffMs > (timeout_MS)) {
				if (timeoutData.notifyOnComplete != null) {
					let notifications = require('./notifications.js');
					let title = "You are ready to post again! :)"
					let body = ""
					let sendNotification = notifications.sendNotification(admin, database, uid, title, body);
					promises.push(sendNotification);
				}
				const setUserCanPost = database.child(`users/timeout/${uid}`).set({
					canPost: true
				});

				promises.push(setUserCanPost);

			} else {
				const progress = diffMs / timeout_MS;

				const setUserTimerUpdate = database.child(`users/timeout/${uid}`).update({
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

exports.calculateAllPostScores = functions.https.onRequest((req, res) => {
	const getActivePosts = database.child(`posts/meta`).orderByChild('status').equalTo('active').once('value');
	return getActivePosts.then(results => {
		var o = {};
		results.forEach(function (post) {
			if (post.val().parent != null) {

			} else {
				o[`posts/meta/${post.key}/needsUpdate`] = true;
			}
		});

		return database.update(o);
	}).then(() => {
		return res.send({
			success: true
		});
	}).catch(e => {
		return res.send({
			success: false
		});
	});
});

exports.tasksWorker = functions.https.onRequest((req, res) => {
	const getUpdatedPosts = database.child(`posts/meta`).orderByChild('needsUpdate').equalTo(true).once('value');
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
				updateObject[`posts/lexicon /${postID}`] = null;
				updateObject[`posts/likes/${postID}`] = null;
				updateObject[`posts/replies/${postID}`] = null;
				updateObject[`posts/reports/${postID}`] = null;
				updateObject[`posts/subscribers/${postID}`] = null;
				updateObject[`posts/meta/needsRemoval/${postID}`] = null;
				updateObject[`posts/meta/${postID}/removedAt`] = Date.now();
				promises.push(database.update(updateObject));
			} else {
				const postRef = firestore.collection('posts').doc(postID);
				var m = {
					numLikes: data.numLikes != null ? data.numLikes : 0,
					numReplies: data.numReplies != null ? data.numReplies : 0,
					numCommenters: data.numCommenters != null ? data.numCommenters : 0,
					reports: data.reports != null ? data.reports : 0,
				};

				const score = hackerHotScore(m.numLikes + m.numCommenters, new Date(data.createdAt));
				m['score'] = score;
				console.log("POST SCORE: ", score, " M: ", m);
				promises.push(postRef.update(m));
			}
		});
		return Promise.all(promises);
	}).then(() => {
		var updateObject = {};
		for (var i = 0; i < postIDs.length; i++) {
			updateObject[`posts/meta/${postIDs[i]}/needsUpdate`] = null;
		}
		return database.update(updateObject);
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

exports.postUpdateLikes = functions.database.ref('app/posts/likes/{postID}/{uid}').onWrite((change, context) => {
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

	var postData = null;
	var postAuthor = null;
	var promise = Promise.resolve();
	var subscribed = false;
	if (newCount != 0) {
		const postLikesRef = database.child(`posts/meta/${postID}/numLikes`);
		promise = postLikesRef.transaction(function (numLikes) {
			if (numLikes) {
				numLikes += newCount;
			} else {
				numLikes = newCount;
			}
			return numLikes;
		});
	}

	var updatedCount = null;
	return promise.then(transactionResult => {
		updatedCount = transactionResult.snapshot.val();
		const setNeedsUpdate = database.child(`posts/meta/${postID}/needsUpdate`).set(true);
		return setNeedsUpdate;
	}).then(() => {
		if (prevData != null) {
			return Promise.resolve();
		}
		const promises = [
            firestore.collection('posts').doc(postID).get(),
            database.child(`posts/meta/${postID}/author`).once('value')
        ];
		return Promise.all(promises);

	}).then(results => {
		if (prevData != null) {
			return Promise.resolve();
		}

		postData = results[0].data();
		postAuthor = results[1].val();

		if (postAuthor == null || postData == null) {
			return Promise.reject('Null post data and/or author');
		}

		return database.child(`posts/subscribers/${postID}/${postAuthor}`).once('value');


	}).then(_subscribed => {

		if (prevData != null || subscribed == null || updatedCount == null) {
			return Promise.resolve();
		}

		subscribed = _subscribed.val() != null ? _subscribed.val() : false;

		if (!subscribed || postAuthor == uid) {
			return Promise.resolve();
		}

		const notificationID = `POST_LIKES:${postID}`
		var notificationObject = {
			timestamp: Date.now(),
			type: "POST_LIKES",
			numLikes: updatedCount,
			postID: postID,
			seen: false,
			text: trim(postData.textClean)
		};

		const notificationsRef = database.child(`users/notifications/${postAuthor}/${notificationID}`);

		return notificationsRef.remove().then(() => {
			return notificationsRef.set(notificationObject);
		}).catch(e => {
			return notificationsRef.set(notificationObject);
		});

	}).catch(e => {
		console.log("Error: ", e);
		return Promise.reject(e);
	})
});

exports.postUpdateReplies = functions.database.ref('app/posts/replies/{postID}/{replyID}').onWrite((change, context) => {
	const postID = context.params.postID;

	const prevData = change.before.val();
	const data = change.after.val();
	var newCount = data != null ? 1 : -1;

	const postRepliesRef = database.child(`posts/meta/${postID}/numReplies`);
	return postRepliesRef.transaction(function (numReplies) {
		if (numReplies) {
			numReplies += newCount;
		} else {
			numReplies = newCount;
		}
		return numReplies;
	}).then(() => {
		const setNeedsUpdate = database.child(`posts/meta/${postID}/needsUpdate`).set(true);
		return setNeedsUpdate;
	});
});

exports.postUpdateCommenters = functions.database.ref('app/posts/commenters/{postID}/{uid}').onWrite((change, context) => {
	const postID = context.params.postID;

	const prevData = change.before.val();
	const data = change.after.val();
	var newCount = data != null ? 1 : -1;

	const postRepliesRef = database.child(`posts/meta/${postID}/numCommenters`);
	return postRepliesRef.transaction(function (numCommenters) {
		if (numCommenters) {
			numCommenters += newCount;
		} else {
			numCommenters = newCount;
		}
		return numCommenters;
	}).then(() => {
		const setNeedsUpdate = database.child(`posts/meta/${postID}/needsUpdate`).set(true);
		return setNeedsUpdate;
	});
});

exports.postUpdateReports = functions.database.ref('app/posts/reports/{postID}/{uid}').onWrite((change, context) => {
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

	const postReportsRef = database.child(`posts/meta/${postID}/reports`);
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
		const setNeedsUpdate = database.child(`posts/meta/${postID}/needsUpdate`).set(true);
		return setNeedsUpdate;
	});
});


exports.sendUserNotification = functions.database.ref('app/users/notifications/{uid}/{notificationID}').onWrite((change, context) => {
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


exports.postRemove = functions.https.onCall((data, context) => {
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

	const getAuthor = database.child(`posts/meta/${postID}`).once('value');
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

				const getSubscribers = database.child(`posts/subscribers/${parent}`).once('value');
				return getSubscribers;

			}).then(_subscribers => {
				var subscribers = _subscribers.val();
				var promises = [];
				for (var subscriberID in subscribers) {
					const getPostNotifications = database.child(`users/notifications/${subscriberID}`)
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
							const promise = database.child(`users/notifications/${snapshot.key}/${notification.key}`).remove();
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

exports.postDelete = functions.firestore.document('posts/{postID}').onDelete((change, context) => {
	const postID = context.params.postID;
	const deletePostMeta = database.child(`posts/meta/${postID}`).remove();
	return deletePostMeta;
});

exports.postUpdate = functions.firestore.document('posts/{postID}').onUpdate((change, context) => {
	const postID = context.params.postID;
	const data = change.after.data();

	const prevData = change.before.data();

	if (data != null && data.status === 'removed') {

		var uid;
		var batchSize = 20;
		const group = prevData.group;

		const getMeta = database.child(`posts/meta/${postID}`).once('value');
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
			if (group) {
				var groupRef = firestore.collection('groups').doc(group);
				var transaction = firestore.runTransaction(t => {
					return t.get(groupRef)
						.then(doc => {
							// Add one person to the city population
							var newNumPosts = 0;
							if (doc.data().numPosts != null) {
								newNumPosts = doc.data().numPosts - 1;
							}

							t.update(groupRef, {
								numPosts: newNumPosts
							});
						});
				});
				return transaction;
			} else {
				return Promise.resolve();
			}
		}).then(() => {
			const deleteIndexObject = postsAdminIndex.deleteObject(postID);
			return deleteIndexObject;
		}).then(() => {
			const getSubscribers = database.child(`posts/subscribers/${postID}`).once('value');
			return getSubscribers;
		}).then(_subscribers => {
			var subscribers = _subscribers.val();
			var promises = [];
			for (var subscriberID in subscribers) {
				const getPostNotifications = database.child(`users/notifications/${subscriberID}`).orderByChild('postID').equalTo(postID).once('value');
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
						const promise = database.child(`users/notifications/${snapshot.key}/${notification.key}`).remove();
						promises.push(promise);
					});
				}
			}
			return Promise.all(promises.map(promiseReflect));
		}).then(() => {
			var updateObject = {};
			updateObject[`posts/meta/${postID}/needsUpdate`] = true;
			updateObject[`posts/meta/${postID}/needsRemoval`] = true;
			updateObject[`posts/meta/${postID}/status`] = 'removed';
			return database.update(updateObject);
		}).then(() => {

			const repliesRef = firestore.collection('posts').where('status', '==', 'active').where('parent', '==', postID)
			const repliesQuery = repliesRef.orderBy('createdAt').limit(batchSize);
			return new Promise((resolve, reject) => {
				markQueryBatchForRemoval(firestore, repliesQuery, batchSize, resolve, reject);
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
			score: data.score != null ? data.score : 0
		};
		metaObject['objectID'] = postID;

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

String.prototype.isAlphaNumeric = function () {
	var regExp = /^[A-Za-z0-9]+$/;
	return (this.match(regExp));
};
