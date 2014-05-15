'use strict';
var config = require('./config.json');
var async = require('async');
var connect = require('connect');
var validjson = require('validjson');
var request = require('request');
var bignum = require('bignum');
var util = require('util');
var fs = require('fs');
var app = connect();
var WebSocketServer = require('ws').Server;
var server = require('http').createServer(app).listen(config.port);
var steamBig = bignum('76561197960265728');
var apikey = config.apikey;
var usrApiUrl = 'http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=' + apikey + '&steamids=';
var gamesApiUrl = 'http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=' + apikey + '&steamid=';
var sIdRegx = /^STEAM_[01]:[01]:\d{1,10}$/;
var xmlRegex = /<steamID64>(.*?)<\/steamID64>/;
var urlRexex = /http(s)?:\/\/steamcommunity.com\/id\//;
var index = __dirname + '/public/index.html';
var header = {'Content-Type': 'text/html'};
app.use(connect.favicon());
app.use(function handler(req, res) {
    if (req.method === 'GET') {
        res.writeHead(200, header);
        return fs.createReadStream(index).pipe(res);
    }
    res.statusCode = 418;
    res.end('no coffee...');
});
 
// set up the websocket server
var wss = new WebSocketServer( { server: server } );
wss.clientConnections = {};
 
wss.on('connection', function wsConnectionHandler(connection) {
    var cid = connection.upgradeReq.headers['sec-websocket-key'];
    connection.id = cid;
    this.clientConnections[cid] = setConnectionListeners(connection);
});
 
function convertTo64bitId(val) {
  var parts = val.split(':');
  return bignum(parts[2]).mul(2).add(steamBig).add(bignum(parts[1])).toString();
}

function getIdFromCustomUrl(url, cid) {
    var urlParts = url.split('/');
    var getUrl;
    while (urlParts.length && !getUrl) getUrl = urlParts.pop();
    if (!getUrl) return sendBack(new Error('invalid url'), cid);
    sendBack(null, cid, { type:'status', message: 'getting id for vanity name: ' + getUrl });
    request('http://steamcommunity.com/id/' + getUrl + '/?xml=1', function xmlCb(err, res, data) {
        var match;
        if (data) match = data.match(xmlRegex);
        if (err || !data || !match || match.length < 2) return sendBack(err ? err : new Error('no data recieved from steam, check the query and try again'), cid);
        return getStuffFromSteam(match[1], cid);
    });
    return sendBack(null, cid, { type:'status', message: 'waiting response from steam...' });
}

function getStuffFromSteam(part, cid) {
    sendBack(null, cid, { type:'status', message:'getting games for id ' + part });
    var gamesUrl = gamesApiUrl + part + '&format=json&include_appinfo=1';
    var usrUrl = usrApiUrl + part + '&format=json';
    var datas = { type: 'games' };
    async.map([gamesUrl, usrUrl], function reqRepeat(url, callback) {
        request(url, function reqCallback(err, res, data) {
            if (err || res.statusCode !== 200 || !data) return callback(err ? err : new Error('empty answer from steam, retry later'));
            var json = validjson(data);
            if (!json) return callback(new Error('invalid answer from steam'));
            return callback(null, json.response);
        });
    }, function mapCallback(err, result) {
        if (err) return sendBack(err, cid);
        result.forEach(function responseIterator(data) {
            datas = Object.keys(data).reduce(function dataReducer(obj, key) {
                obj[key] = data[key];
                return obj;
            }, datas);
        });
        return sendBack(null, cid, datas);
    });
    return sendBack(null, cid, { type:'status', message:'waiting response from steam...' });
}

function sendBack(err, cid, data) {
    var connection = wss.clientConnections[cid];
    if (!connection || connection.readyState !== 1) return;
    if (err) err.type = 'error';
    var sendData = JSON.stringify((err || data), err ? Object.getOwnPropertyNames(err) : null);
    return connection.send(sendData);
}

// a function to set websocket connection eventlisteners and callbacks
function setConnectionListeners(connection) {
    connection.on('message', function (message) {
        message = message.trim();
        sendBack(null, connection.id, { type:'status', message: 'got request for: ' + message });
        if (sIdRegx.test(message)) message = convertTo64bitId(message);
        if (message.length >= 16 && !isNaN(+message)) return getStuffFromSteam(message, connection.id);
        return getIdFromCustomUrl(message, connection.id);
    })
    .on('error', function (error) { /*just catch it*/ })
    .on('close', function () {
        delete wss.clientConnections[connection.id];
    });
    return connection;
}
