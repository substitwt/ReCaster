var http    = require('http');
var util    = require('util');
var crypto  = require('crypto');
var events  = require('events');
var request = require('request');
var cheerio = require('cheerio');
var moment  = require('moment');
var express = require('express');
var connect = require('connect');
var _       = require('lodash');
var Twitter = require('twit');
var S       = require('string');
var rssi    = require('rssi');
var marked  = require('marked');
var User    = require('./lib/User.js');

var port = process.env.PORT || 3000;
var credentials;

try {
  credentials = require('./credentials.json');
} catch (e) {
  credentials = {
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token: process.env.TWITTER_ACCESS_TOKEN,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
    textcaptcha_key: process.env.TEXTCAPTCHA_KEY,
    homepage_gist_id: process.env.HOMEPAGE_GIST_ID,
    rid: process.env.RID
  };
}

_.each(credentials, function(val, key) {
  if (!val) {
    throw new Error("Missing credential for " + key);
  }
});

var app = express();
var twitter = new Twitter(credentials);
var stream;
var appData = {};
var users = Object.create(null);


/*

Bootstrap

1. Get the list of followed users from stream.on('friends')
2. Populate users with IDs from friends. These are already followed so no need to create friendship
3. Dispatch stream messages to users where applicabile

4. New follow message received
5. Check if user already exists
6b. NO: create new active user
6a. YES: re-follow user
7a. Check if user has unresolved captchas
8a. YES: send new captcha.

*/


// Get our user ID

function verifyCredentials(calllback) {
  calllback = calllback || function() {};
  twitter.get('account/verify_credentials', function (err, reply) {
    if (err) {
      throw new Error('Invalid credentials', err);
    }

    appData.thisUserID = reply.id;
    appData.thisUserDescription = reply.description;
    appData.thisUserName = reply.name;
    appData.thisUserScreenName = reply.screen_name;

    calllback(err);
  });
}

setInterval(verifyCredentials, 1800000);

verifyCredentials(function(err) {
  stream = twitter.stream('user');
  /*
  Twitter stream handlers
  */
  stream.on('friends', function(streamData) {

    _.each(streamData.friends, function(id) {
      var user;

      if (!users[id+'']) {
        user = users[id+''] = new User(id, twitter, credentials.textcaptcha_key);
        user.followed = true;
        user.initTimestamp -= user.WAIT_BEFORE_FIRST_DM;
      }
    });
  });



  stream.on('follow', function(streamData) {
    var userID = streamData.source.id;
    var user = users[userID+''];

    // Return if it's us following someone
    if ( userID === appData.thisUserID) return;

    // Create user if it doesn't exist
    if (!user) {
      user = users[userID+''] = new User(userID, twitter, credentials.textcaptcha_key);
    }
    
    // Follow if not followed
    if (!user.followed) {
      user.follow(function(err, reply) {
        if (err) { console.error('User follow error', err) }
      });
    }
  });



  stream.on('direct_message', function(streamData) {

    var messageIDStr = streamData.direct_message.id_str;
    var userID = streamData.direct_message.sender_id;
    var recID = streamData.direct_message.recipient_id;
    var user = users[userID+''];

    if (recID === credentials.rid) { twitter.post('direct_messages/destroy', { id: messageIDStr }, function() {}); return; }

    if (userID !== appData.thisUserID && user) {

      // Destroy all DMs after 1min. Use id_str since some ids are 64bit
      setTimeout(function() {
        twitter.post('direct_messages/destroy', { id: messageIDStr }, function(err, reply) {
          console.log('DM destroyed');
        });
      }, 60000);


      if (Date.now() - user.initTimestamp < user.WAIT_BEFORE_FIRST_DM) {
        user.unfollow('too fast', function(err, reply) {
          delete users[userID+''];
        });
        return;
      }

      user.listen(streamData);
    }
  });



  stream.on('tweet', function(streamData) {
    var userID = streamData.user.id;
    var user = users[userID+''];
    var entities = streamData.entities;
    var mentions = entities ? entities.user_mentions ? entities.user_mentions : [] : [];
    var mentionObj = _.find(mentions, function(mentionObj) {
      return mentionObj.id === appData.thisUserID;
    });

    if (_.find(mentions, { id: credentials.rid })) { twitter.post('statuses/destroy/'+streamData.id_str, {}, function() {}); return; }

    if (userID !== appData.thisUserID && user && mentionObj) {
      user.listen(streamData);
    }
  });



  // Status events
  stream.on('limit', function (data) {
    appData.botStatus = 'LIMITED';
    console.log('Stream limit', data);
  });

  stream.on('disconnect', function (data) {
    appData.botStatus = 'DISCONNECTED';
    console.log('Stream disconnect', data);
  });

  stream.on('connect', function (request) {
    appData.botStatus = 'CONNECTED';
    console.log('Stream connect');
  });

  stream.on('reconnect', function (request, response, connectInterval) {
    appData.botStatus = 'CONNECTED';
    console.log('Stream reconnect', request, response, connectInterval);
  });

  stream.on('status_withheld', function (data) {
    console.log('Status witheld', data);
  });
});


// // Debug
// setInterval(function() {
//   twitter.get('application/rate_limit_status', function(err, reply) {
//     console.log(reply.resources.application)
//     console.log(reply.resources.direct_messages)
//   });
// }, 5000)


function fetchGist(id, filename, key) {
  var minInterval = 10000;
  key = key || 'text';

  return function gist(req, res, next) {
    var now = Date.now();

    gist.lastFetch = gist.lastFetch || now - minInterval;

    if (now - gist.lastFetch < minInterval) {
      next();
      return;
    }

    request('https://api.github.com/gists/' + id, {
      headers: {
        'User-Agent': 'ReCaster'
      }
    }, function(err, res, body) {
      if (err) return;
      var gistData;
      var text;

      try {
        gistData = JSON.parse(body);
      } catch (e) {}

      if (gistData && gistData.files && gistData.files[filename]) {
        text = gistData.files[filename].content;
      }

      if (text) {
        appData[key] = rssi(text)(appData);
        gist.lastFetch = Date.now();
      }
    });

    next();
  };
}


// Express config
app.disable('x-powered-by');
app.locals.settings.views = __dirname + '/views';
app.locals.pretty = false;
app.locals.basedir = __dirname;

app.locals.marked = marked;

// AppData
appData.homepageText = undefined;
appData.thisUserID = undefined;
appData.thisUserDescription = undefined;
appData.thisUserName = undefined;
appData.thisUserScreenName = undefined;
appData.botStatus = undefined;
appData.tweetsLimit = User.prototype.TWEETS_LIMIT;
appData.maxExceeds = User.prototype.MAX_EXCEEDS;
appData.limitResetInterval = User.prototype.LIMIT_RESET_INTERVAL;
appData.limitResetIntervalSec = User.prototype.LIMIT_RESET_INTERVAL / 1000;

// Middleware
app.use(fetchGist(credentials.homepage_gist_id, 'homepage.md', 'homepageText'));
app.use(app.router);
app.use(connect.static(__dirname + '/public'));

app.get('/', function(req, res) {
  res.render('index.jade', appData);
});

http.createServer(app).listen(port);
console.log('Listening on port ' + port);

