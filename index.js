'use strict';

const https = require('https');
const NS_PER_SEC = 1e9;
const MS_PER_NS = 1e6;

function getHrTimeDurationInMs(startTime, endTime) {
    const secondDiff = endTime[0] - startTime[0];
    const nanoSecondDiff = endTime[1] - startTime[1];
    const diffInNanoSecond = secondDiff * NS_PER_SEC + nanoSecondDiff;
    return diffInNanoSecond / MS_PER_NS;
}

function getTimings(eventTimes) {
    return {
        dnsLookup: eventTimes.dnsLookupAt !== undefined ?
            getHrTimeDurationInMs(eventTimes.startAt, eventTimes.dnsLookupAt) : undefined,
        tcpConnection: getHrTimeDurationInMs(eventTimes.dnsLookupAt || eventTimes.startAt, eventTimes.tcpConnectionAt),
        tlsHandshake: eventTimes.tlsHandshakeAt !== undefined ?
            (getHrTimeDurationInMs(eventTimes.tcpConnectionAt, eventTimes.tlsHandshakeAt)) : undefined,
        firstByte: getHrTimeDurationInMs((eventTimes.tlsHandshakeAt || eventTimes.tcpConnectionAt), eventTimes.firstByteAt),
        contentTransfer: getHrTimeDurationInMs(eventTimes.firstByteAt, eventTimes.endAt),
        total: getHrTimeDurationInMs(eventTimes.startAt, eventTimes.endAt)
    };
}

let eventTimes = resetEventTimes();
function resetEventTimes() {
    return {
        startAt: process.hrtime(),
        dnsLookupAt: undefined,
        tcpConnectionAt: undefined,
        tlsHandshakeAt: undefined,
        firstByteAt: undefined,
        endAt: undefined
    };
}

function sendHttpRequest(options, body = null) {
    return new Promise((resolve, reject) => {
        eventTimes = resetEventTimes();
        let request = https.request(options, response => {
            let buffers = [];
            response
                .once('readable', () => eventTimes.firstByteAt = process.hrtime());
            response
                .on('data', data => buffers.push(data))
                .on('end', () => {
                    eventTimes.endAt = process.hrtime();
                    const returnedResult = {
                        status: response.statusCode,
                        data: Buffer.concat(buffers).toString('utf-8')
                    };
                    resolve(returnedResult);
                })
                .on('error', error => reject(error));
        });
        request.on('socket', socket => {
            socket
                .on('lookup', () => eventTimes.dnsLookupAt = process.hrtime())
                .on('connect', () => eventTimes.tcpConnectionAt = process.hrtime())
                .on('secureConnect', () => eventTimes.tlsHandshakeAt = process.hrtime())
                .on('timeout', () => {
                    request.abort();
                    const err = new Error('ETIMEDOUT');
                    err.code = 'ETIMEDOUT';
                    reject(err);
                });
        });
        request.on('error', error => reject(error));
        if (body) {
            if (typeof body !== 'string') {
                request.write(JSON.stringify(body));
            } else {
                request.write(body);
            }
        }
        request.end();
    });
}

async function measure(requestOptions, requestBody) {
    try {
        await sendHttpRequest(requestOptions, requestBody);
	
	console.log(`Duration ${JSON.stringify(getTimings(eventTimes))}`);
    } catch (error) {
        console.error(error);
	throw new Error(`Unable to measure '${method}' '${hostname}' '${path}'`);
    }
}

exports.measureLatency = (event, context) => {
    const pubsubMessage = event.data;
    const request = JSON.parse(Buffer.from(pubsubMessage, 'base64').toString());
    const { method, hostname, path, headers, body } = request;
    
    const options = {
        hostname,
        path,
        port: 443,
        method,
        headers
    };

    measure(options, body)
        .then(() => console.log(`Measurement for URL '${method}' '${hostname}' '${path}' has been finished`))
        .catch(err => console.error(err));
};

