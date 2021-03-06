'use strict'

const eos = require('end-of-stream')
const hyperid = require('hyperid')
const extractBase = require('./extractBase')
const PassThrough = require('readable-stream').PassThrough

function load (pubsub) {
  const destSet = new Set()
  const idgen = hyperid()
  const upring = pubsub.upring
  const internal = pubsub._internal

  const tick = function () {
    destSet.clear()
  }

  // publish command
  upring.add('ns:pubsub,cmd:publish', function (req, reply) {
    if (pubsub.closed) {
      reply(new Error('instance closing'))
      return
    }

    pubsub.logger.debug(req, 'emitting')
    internal.emit(req.msg, reply)

    if (!upring.allocatedToMe(req.key)) {
      const next = upring._hashring.next(req.key)

      if (next) {
        upring.peerConn(next).request(req, function (err) {
          if (err) {
            upring.logger.warn(err, 'error replicating')
            return
          }
          upring.logger.debug(req, 'publish replicated')
        })
      }
    }
  })

  // Subscribe command
  upring.add('ns:pubsub,cmd:subscribe', function (req, reply) {
    const logger = pubsub.logger.child({
      incomingSubscription: {
        topic: req.topic,
        key: req.key,
        id: idgen()
      }
    })

    const dest = req.from

    if (pubsub.closed) {
      logger.warn('ring closed')
      return reply(new Error('closing'))
    }

    const stream = new PassThrough({ objectMode: true })

    // the listener that we will pass to MQEmitter
    function listener (data, cb) {
      if (destSet.has(dest)) {
        logger.debug(data, 'duplicate data')
        // message is a duplicate
        cb()
      } else if (!upring.allocatedToMe(extractBase(data.topic))) {
        // nothing to do, we are not responsible for pubsub
        logger.debug(data, 'not allocated here')
        cb()
      } else {
        logger.debug(data, 'writing data')
        stream.write(data, cb)
        destSet.add(dest)
        // magically detect duplicates, as they will be emitted
        // in the same JS tick
        process.nextTick(tick)
      }
    }

    var tracker

    logger.info('subscribe')

    if (req.key) {
      if (upring.allocatedToMe(req.key)) {
        // close if the responsible peer changes
        // and trigger the reconnection mechanism on
        // the other side
        tracker = upring.track(req.key)
        tracker.on('move', () => {
          logger.info('moving subscription to new peer')
          internal.removeListener(req.topic, listener)
          if (stream.destroy) {
            stream.destroy()
          } else {
            stream.end()
          }
        })
      } else {
        logger.warn('unable to subscribe, not allocated here')
        internal.removeListener(req.topic, listener)
        if (stream.destroy) {
          stream.destroy()
        } else {
          stream.end()
        }
      }
    }

    // remove the subscription when the stream closes
    eos(stream, () => {
      logger.info('stream closed')
      if (tracker) {
        tracker.end()
      }
      internal.removeListener(req.topic, listener)
    })

    internal.on(req.topic, listener, () => {
      // confirm the subscription
      reply(null, { streams: { messages: stream } })
    })
  })
}

module.exports = load
