var util    = require('util');
var crypto  = require('crypto');
var events  = require('events');
var request = require('request');
var cheerio = require('cheerio');
var moment  = require('moment');
var _       = require('lodash');
var S       = require('string');

var noop = function() {};

var User = function(id, twitter, captchaKey) {
  if (!id || typeof id !== 'number') { throw new Error("Cannot create user without an ID"); }
  if (!twitter) { throw new Error("User missing twitter instance"); }
  if (!captchaKey) { throw new Error("User missing twitter captcha API key"); }

  this.id = id;
  this.twitter = twitter;
  this.captchaKey = captchaKey;
  this.tweetsRemaining = this.TWEETS_LIMIT;
  this.timesLimitExceeded = 0;
  this.captchaAnswersMd5 = [];
  this.followed = false;
  this.initTimestamp = Date.now();
  
  setInterval(_.bind(function() {
    this.tweetsRemaining = this.TWEETS_LIMIT;
  }, this), this.LIMIT_RESET_INTERVAL);

  setInterval(_.bind(function() {
    this.timesLimitExceeded = 0;
  }, this), this.MAX_EXCEEDS_RESET_INTERVAL);

};

// Not in use
util.inherits(User, events.EventEmitter);

// Prototype constants
User.prototype.TWEETS_LIMIT = 4;
User.prototype.LIMIT_RESET_INTERVAL = 240000;
User.prototype.MAX_EXCEEDS = 5;
User.prototype.MAX_EXCEEDS_RESET_INTERVAL = 86400000; // 24hr;
User.prototype.WAIT_BEFORE_FIRST_DM = 5000;
User.prototype.UNFOLLOW_COMMANDS = ['bye', 'unfollow', 'unfollow me', 'stop'];
User.prototype.WELCOME = 'Hi. You can unfollow me now.\nMore info @ recaster.herokuapp.com\n\nYour DMs to us will now appear on @savethetweet.';
User.prototype.CAPTCHA_PREPEND_FIRST = 'Human check:\n';
User.prototype.CAPTCHA_PREPEND_NTH = 'Wrong, try again:\n';
User.prototype.GOODBYE = 'Bye. Sorry to see you go.';
User.prototype.CAPTCHA_SOLVED = 'Thank you, I think you are a human. You can now tweet again.';
User.prototype.LIMIT_NOTICE = "I didn't tweet your last message. %d PMs every %d seconds max. Please wait %s before trying again.";


User.prototype.listen = function(streamData) {
  var text = streamData.direct_message ? streamData.direct_message.text : streamData.text;

  // Unfollow command
  if (this.UNFOLLOW_COMMANDS.indexOf(S(text).trim().s.toLowerCase()) >= 0) {
    this.unfollow('requested');
    return;
  }

  // Limits exceeded too many times. Send captcha.
  if (this.timesLimitExceeded === this.MAX_EXCEEDS) {
    this.sendCaptcha();
    return;
  }

  // Pending captcha
  if (this.captchaAnswersMd5.length) {
    this.verifyCaptcha(text);
    return;
  }

  // All clean. Recast if it is a direct message
  if (streamData.direct_message) {
    this.speak(streamData, function(err, reply) {
      if (err) {
        console.log(err);
      }
    });
  }
};



User.prototype.sendLimitNotice = function(streamData, callback) {
  callback = callback || noop;
  var text = util.format(
    this.LIMIT_NOTICE,
    this.TWEETS_LIMIT,
    Math.round(this.LIMIT_RESET_INTERVAL / 1000),
    moment.duration(this.getDurationUntilReset()).humanize()
  );

  this.sendMessage(text, _.bind(function(err, reply) {
    callback.call(this, err, reply);
  }, this));
};



User.prototype.lookupFriendship = function(callback) {
  callback = callback || noop;
  this.twitter.get('friendships/lookup', {
    user_id: this.id+''
  }, _.bind(function(err, reply) {
    if (err) {
      console.error(err);
    }
    var userObj = reply[0];
    var follows_us = _.find(userObj.connections, function(str) {
      return str === 'followed_by';
    });

    callback.call(this, err, userObj, follows_us);
  }, this));
};



User.prototype.sendCaptcha = function(callback) {
  console.log('sending captcha', this.id);
  callback = callback || noop;
  this.timesLimitExceeded = 0;
  var text = !(this.captchaAnswersMd5.length) ? this.CAPTCHA_PREPEND_FIRST : this.CAPTCHA_PREPEND_NTH;

  request('http://api.textcaptcha.com/' + this.captchaKey, _.bind(function(err, res, body) {
    if (res.statusCode > 200) {
      console.error('sendCaptcha response error ', res.statusCode);
      this.captchaAnswersMd5 = [];
      callback.call(this, res);
      return;
    }

    var $ = cheerio.load(body, {normalizeWhitespace: true, xmlMode: true});
    var questionText = $('question').text();
    var $answers = $('answer');

    this.captchaAnswersMd5 = [];
    $answers.each(_.bind(function(i, el) {
      this.captchaAnswersMd5.push($(el).text());
    }, this));

    this.sendMessage(text + questionText, _.bind(function(err, reply) {
      callback.call(this, err, reply);
    }, this));
  }, this));
};



User.prototype.sendMessage = function(text, publicText, callback) {
  publicText = publicText || text;
  
  if (typeof publicText === 'function') {
    callback = publicText;
    publicText = text;
  }

  var endpoint;
  var params;
  
  this.lookupFriendship(_.bind(function(err, userObj, follows_us) {
    if (follows_us) {
      endpoint = 'direct_messages/new';
      params = { user_id: this.id, text: text };
    } else {
      endpoint = 'statuses/update';
      params = { status: "@" + userObj.screen_name + ' ' + publicText };
    }

    this.twitter.post(endpoint, params, _.bind(function(err, reply) {
      if (err) { console.error(err); }
      callback.call(this, err, reply);
    }, this));

  }, this));
};



User.prototype.verifyCaptcha = function(answer, callback) {
  callback = callback || noop;
  var userAnswer = S(answer).trim().s.toLowerCase();
  var md5sum = crypto.createHash('md5');
  var userAnswerMd5 = md5sum.update(userAnswer).digest('hex');

  if (this.captchaAnswersMd5.indexOf(userAnswerMd5) >= 0) {
    this.captchaAnswersMd5 = [];

    this.sendMessage(this.CAPTCHA_SOLVED, _.bind(function(err, reply) {
      callback.call(this, err, reply);
    }, this));

  } else {
    this.sendCaptcha();
  }
};



User.prototype.follow = function(callback) {
  this.twitter.post('friendships/create', { user_id: this.id }, _.bind(function(err, reply) {    
    if (!err) {
      console.log('friendships/create', this.id);
      this.followed = true;
    }

    this.twitter.post('friendships/update', { user_id: this.id, device: false,  retweets: false }, _.bind(function(err, reply) {
      if (err) {
        console.log('friendships/update', this.id);
      }
    }, this));

    callback.call(this, err, reply);

    this.twitter.post('direct_messages/new', {
      user_id: this.id,
      text: this.WELCOME
    }, function(err, reply) {
      console.log('Welcome message sent');
    });
  }, this));
};



User.prototype.unfollow = function(reason, callback) {
  var self = this;
  callback = callback || noop;
  reason = reason || 'requested';

  if (typeof reason === 'function') {
    callback = reason;
    reason = 'requested';
  }

  if (reason === 'too fast') {
    this.twitter.post('friendships/destroy', { user_id: this.id }, _.bind(function(err, reply) {
      if (!err) { this.followed = false; }
      callback.call(this, err, reply);
    }, this));
    return;
  }

  this.sendMessage(this.GOODBYE, _.bind(function(err, reply) {
    console.log('Goodbye ', this.id);
    this.twitter.post('friendships/destroy', { user_id: this.id }, _.bind(function(err, reply) {
      if (!err) { this.followed = false; }
      callback.call(this, err, reply);
    }, this));
  }, this));
};



User.prototype.getDurationUntilReset = function(argument) {
  var elapsed = (Date.now() - this.initTimestamp) % this.LIMIT_RESET_INTERVAL;
  return this.LIMIT_RESET_INTERVAL - elapsed;
};



User.prototype.speak = function(streamData, callback) {
  callback = callback || noop;
  var statusDecoded;

  if (this.tweetsRemaining > 0) {
    this.tweetsRemaining--;
    statusDecoded = S(streamData.direct_message.text).decodeHTMLEntities().s;
    this.twitter.post('statuses/update', { status: statusDecoded }, function(err, reply) {
      callback.call(this, err, reply);
    });
  } else {
    this.sendLimitNotice(streamData);
    if (this.tweetsRemaining === 0) {
      this.timesLimitExceeded++;
    }
    callback.call(this, new Error('User rate limit reached'));
  }
};


exports = module.exports = User;



