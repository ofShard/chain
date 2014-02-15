chain
=====

An asynchronouse flow control library for chaining calls

#### How to use

```js
var C = require('chain');

var ch = C.nCall(fs.readFile, fs, 'config.json')
  .chain(function(data) {
    config = JSON.parse(data);

    if (config.remote) {
      this.nCall(doGetRemote, null, config.remote)
        .chain(function(data) {
          config.data = data

          return config;
        });
    }

    return config;
  })
  .chain(function(config) {
    var ch = this.nCall(MyDB.connect, MyDB, config.db1);
    ch.fail(function(err) {
      this.nCall(MyOtherDB.connect, MyDB, config.db2);
    });
    
    return ch;
  })
  .chain(function() {
    doInit();
  })
  .fail(function(err) {
    // If an error occurs, all chains will be skipped.
  });
```
