const Nightmare = require('nightmare')
const http = require('http')
const request = require('request')
const omit = require('lodash.omit')
const parseUrl = require('url').parse
const decamelize = require('decamelize')
const fs = require('fs')

const PORT = 8488
const REDIRECT_URI = 'http://localhost:' + PORT
const BASE_URL = 'https://accounts.google.com/o/oauth2/auth'
const GOOGLE_OAUTH2_TOKEN_URL = 'https://accounts.google.com/o/oauth2/token'

const maxTimeout = 6e4
const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/48.0.2564.109 Safari/537.36'

const IS_VERBOSE = !!process.env.DEBUG; // booleanize
const debugScreenshotDir = "debug-screens-nightmare-google-auth" // in run directory of project
fs.existsSync(debugScreenshotDir) || fs.mkdirSync(debugScreenshotDir) // create if not exist

const getCode = exports.getCode = function (params, callback, onChange) {
  const url = buildUrl(params)

  if (!params.email || !params.password) {
    return callback(new Error('Missing required params: email, password'))
  }

  return function (nightmare) {
    startCallbackServer(callback, nightmare)

    nightmare
      .viewport(800, 1600)
      .useragent(userAgent)
      .use(login)

    function login (nightmare) {
      IS_VERBOSE && console.log(`[D] nightmare-google-auth.login - Logging in via ${url}`);

      nightmare
        .goto(url)
        .wait(2000) //.wait('input[type=email]')
        .type('input[type=email]', params.email)
        .exists('#next').then(function (exists) {
          nightmare.click(exists ? '#next' : '#identifierNext') // #identifierNext is 2017's new ID
          .wait(1000)
          .wait('input[type=password]')
          .type('input[type=password]', params.password)
          .exists('#signIn').then(function (exists) {
            IS_VERBOSE && nightmare.screenshot(`${debugScreenshotDir}/login.png`)

            // #passwordNext is 2017's new ID
            nightmare.click(exists ? '#signIn' : "#passwordNext")
            .wait(2000)
            .use(challenge) // do next step
          })
        });
    }

    function challenge (nightmare) {
      nightmare.exists('#challengeform')
      .then(function (exists) {
        // determine next step if necessary
        IS_VERBOSE && console.log(`[D] nightmare-google-auth.challenge - ${exists ? "NOW" : "NOT"} doing challenge`)

        if (exists) {
          nightmare.use(doChallenge)
        } else {
          nightmare.use(signIn)
        }
      })
    }

    function doChallenge (nightmare) {
      nightmare
        .type('input[type=text]', params.verificationEmail)
        .wait(1000)
      
      IS_VERBOSE && nightmare.screenshot(`${debugScreenshotDir}/doChallenge_email.png`)

      nightmare
        .click('input[type=submit]')
        .wait(1000)
        .exists('input[name=ConfirmPassword]')
        .then(function (exists) {
          IS_VERBOSE && nightmare.screenshot(`${debugScreenshotDir}/doChallenge_password.png`)
          IS_VERBOSE && console.log(`[D] nightmare-google-auth.doChallenge - ConfirmPassword does ${exists ? "" : "NOT"} exist`)

          if (exists) {
            nightmare.use(assignPassword)
            nightmare.use(login) // might cause endless loop if the challenge fails... not a big issue cause of timeout
          } else {
            nightmare.use(signIn)
          }
        })
    }

    function assignPassword (nightmare) {
      const newPassword = reverse(params.password)
      if (onChange) onChange('password', newPassword)

      nightmare
        .type('input[name=Password]', newPassword)
        .wait(500)
        .type('input[name=PasswordConfirm]', newPassword)
        .wait(500)
        .click('input[type=submit]')
        .wait(1000)
    }

    function signIn (nightmare) {
      nightmare
        .goto(url)
        .wait(2000)
        .exists('#signin-action')
        .then(function (exists) {
          if (exists) nightmare.use(selectAccount)
          nightmare.use(submit)
        })
    }

    function selectAccount (nightmare) {
      const account = params.useAccount || ''
      nightmare
        .wait(1000)
        .click('#account-' + account + ' > a')
    }

    function submit (nightmare) {
      nightmare
        .exists('#submit_approve_access').then(function (exists) {
          IS_VERBOSE && console.log(`[D] nightmare-google-auth.submit - ${exists ? "selecting first account" : "submitting"}`)

          if (!exists) {
            nightmare.use(selectFirstAccount); // 2017 addition
          } else {
            nightmare
              .wait('#submit_approve_access')
              .wait(1500)
              .click('#submit_approve_access')
              .wait(1500)
              .end(noop)
          }
        })
    }
    function selectFirstAccount (nightmare) {
      nightmare
        .wait(2000)
        .evaluate(function () {
          // Select the first account. Should be the one we are actually signing in for.
          // The classNames are generated and cannot be known; so we use this hideous selector.
          var btn = document.querySelector('form ul li:first-child div:first-child');
          btn.click();
          return btn.className;
        }).then(function (buttonClassNames) {
          nightmare.use(submit);
        });
    }
  }
}


const getToken = exports.getToken = function (params, callback, onChange) {
  let getCodeCall = getCode(params, function (err, code) {
    if (err) return callback(err)

    if (!params.clientSecret) {
      throw missingParam('clientSecret')
    }

    const values = {
      code: code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    }

    request({
      method: 'POST',
      uri: GOOGLE_OAUTH2_TOKEN_URL,
      form: values,
      json: true
    }, function (reqErr, res, tokens) {
      if (!reqErr && tokens && tokens.expires_in) {
        tokens.expiry_date = ((new Date()).getTime() + (tokens.expires_in * 1000))
        tokens = omit(tokens, 'expires_in')
      }

      if (!reqErr && tokens.error) {
        reqErr = new Error(tokens.error_description)
        reqErr.code = tokens.error
        tokens = null
      }

      IS_VERBOSE && console.log("[D] nightmare-google-auth.getToken - tokens:", tokens);

      callback(reqErr, tokens)
    })
  }, onChange)


  new Nightmare({
    show: IS_VERBOSE, // shows what's going on
    dock: IS_VERBOSE, // electron shows up in OS X's dock
    webPreferences: { partition: 'nopersist' }, // DO NOT persist cache/cookies. New session every run
  })
  .use(getCodeCall)
  /*.run(function (err) {
    if (err) callback(err)
  })*/ // unnecessary?
}

function startCallbackServer (callback, nightmare) {
  callback = once(callback)

  var server = http.createServer(function (req, res) {
    res.writeHead(200)
    res.end()

    server.close()
    nightmare.end(noop)
    server = null

    var query = parseUrl(req.url, true).query
    if (!query || !query.code) {
      return callback(new Error('Missing OAuth2 code in callback'))
    }

    callback(null, query.code)
  })

  server.listen(PORT, function (err) {
    if (err) return callback(err)

    // be sure we kill the server in case of timeout/error
    setTimeout(function () {
      if (server) {
        server.close()
        nightmare.end(noop)
        callback(new Error('Cannot retrieve the token. Timeout exceeded'))
      }
    }, maxTimeout)
  })
}

function buildUrl (options) {
  var params = defineDefaultParams(options)

  var query = Object.keys(params).map(function (key) {
    return key + '=' + encodeURIComponent(params[key])
  }).join('&')

  return BASE_URL + '?' + query
}

function defineDefaultParams (params) {
  params = validate(normalize(params))

  if (!params.redirect_uri) {
    params.redirect_uri = REDIRECT_URI
  }
  if (!params.access_type) {
    params.access_type = 'offline'
  }
  params.response_type = 'code'

  return omitPrivateParams(params)
}

function omitPrivateParams (params) {
  return omit(params, 'email', 'password', 'client_secret', 'use_account')
}

function validate (params) {
  ['email', 'password', 'scope', 'client_id'].forEach(function (name) {
    if (!params[name]) {
      throw missingParam(name)
    }
  })
  return params
}

function normalize (params) {
  var buf = {}
  Object.keys(params).forEach(function (key) {
    return buf[decamelize(key)] = params[key]
  })
  return buf
}

function missingParam (name) {
  return new TypeError('Missing required param: ' + name)
}

function once (fn) {
  var one = true
  return function () {
    if (one) {
      one = false
      fn.apply(null, arguments)
    }
  }
}

function reverse (str) {
  return str.split('').reverse().join('')
}

function noop () {}
