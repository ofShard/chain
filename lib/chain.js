var _immediate = false,
	nextTick = process.nextTick,
	PAUSE = {},
	NOW = {},
	TICK = {};

// These three are passed as the initial value of a Chain to affect its state.
// `NOW` sets the Chain's _immediate value to true, which makes it immediately execute
// callbacks, rather than calling them in the next tick. `TICK` does the opposite.
// `PAUSE` initially pauses the Chain. It will not resolve until it is unpaused.

exports.PAUSE = PAUSE;
exports.TICK = TICK;
exports.NOW = exports.IMMEDIATE = NOW;
exports._report = false;

exports.isThenable = isThenable;
function isThenable(object) {
	return object && typeof object.then === 'function';
}

exports.isChainable = isChainable;
function isChainable(object) {
	return object && typeof object.chain === 'function';
}

exports.setImmediate = setImmediate;
function setImmediate(immediate) {
	_immediate = !!immediate;
}

/**
 * Chain - A class for asynchronous execution.
 *
 * Guarantees:
 * The first chain responder will not be called immediately.
 * An earlier function in the chain will never be called after a later one.
 * At most, only one of `fallback` and `errback` will be called, a maximum of one time.
 * `fallback` will be called with `apply` with the chain's current value, which is:
 *     A. The return value of the previously called `fallback`, or
 *     B. If `fallback` returned `undefined` (or nothing), the value before that, or
 *     C. If `fallback` returned [] (empty array), nothing (`undefined`).
 * If a previous callback in the chain threw an error, all `fallback` functions will be
 *     skipped until an `errback` is found. The chain will not rewind to call missed
 *     `fallback` functions.
 * `errback` will be called only if a previous member of the chain either
 *     A. Threw an error, or
 *     B. Called reject on the chain.
 * If an `errback` throws an error, then the chain continues to the next `errback`,
 *     otherwise, the next `fallback` will be called with the `errback`'s return value.
 *
 * Does not guarantee:
 * That additional chain responders will not be executed immediately, or otherwise.
 * That any particular chain responder will be called eventually.
 *
 * @param {*} [value] Sets the initial value of the Chain. To affect the state of the
 * 		Chain, pass `NOW`, `TICK`, or `PAUSE`. To pass a state _and_ an initial value,
 * 		pass an Object with the now, tick, or pause attribute set to the respective
 * 		state, and the desired `value` set to the value attribute. Using this approach
 * 		also enables you to set the `NOW` or `TICK` states (mutually exclusive) along
 * 		with the `PAUSE` state.
 * @param {Function} [fallback]
 * @param {Function} [errback]
 * @param {Boolean} [noHijack=false]
 */
function Chain(value, fallback, errback, noHijack) {
	this._resolving = false;
	this._pending = [];
	this._unPending = [];
	this._errors = [];
	this._report = exports._report;

	if( this._report ) this._uid = Swift.util.uid(4);

	if( value === NOW || value === TICK || value === PAUSE ) {
		if( value === NOW ) this._immediate = true;
		else if( value === TICK ) this._immediate = false;
		else {
			this._immediate = _immediate;
			this._paused = true;
		}

		this._value = undefined;
	}
	else if( typeof value === 'object' ) {
		this._value = value;
		this._immediate = _immediate;

		if ( value.tick === TICK ) {
			this._immediate = false;
			this._value = value.value;
		}

		if( value.now === NOW ) {
			this._immediate = true;
			this._value = value.value;
		}

		if( value.pause === PAUSE ) {
			this._paused = true;
			this._value = value.value;
		}
	}
	else {
		this._immediate = _immediate;
		this._value = value;
	}

	this.chain(fallback, errback, noHijack);
}

function _chain(ctx, fallback, errback, noHijack, prepend) {
	if( isChainable(fallback) ) {
		var args
			, success
			, ch;

		fallback.chain(function() {
			args = Array.prototype.slice.call(arguments);
			success = true;
			if( ch ) ch.next.apply(ch, args);
		}, function() {
			args = Array.prototype.slice.call(arguments);
			success = false;
			if( ch ) ch.reject.apply(ch, args);
		});

		fallback = function() {
			if( args ) {
				if( success ) return args;
				else return this.reject.apply(this, args);
			}

			ch = this.delay();
		};
	}

	if( typeof fallback === 'function' || typeof errback === 'function' ) {
		(prepend ? ctx._unPending : ctx._pending).push(noHijack ? [fallback, errback, true] : [fallback, errback]);
	}
}

Chain.prototype.chain = function(fallback, errback, noHijack) {
	_chain(this, fallback, errback, noHijack);

	this.resolve();

	return this;
};

/**
 * Creates a new chain that starts when the previous chain reaches this point. This new chain
 * does not affect the status of the old chain.
 * @param {Function} [fallback] Function to call on successful completion of the current step.
 * @param {Function} [errback] Function call if an error reached the current step.
 * @returns {Chain} A new Chain that observes this step of the current Chain.
 */
Chain.prototype.then = function(fallback, errback) {
	var ctx
		, ch = start(NOW, function() { ctx = this.pause(); });

	function _fallback() {
		if( fallback ) fallback.apply(undefined, arguments);
		ctx.next();
	}
	function _errback() {
		if( errback ) errback.apply(undefined, arguments);
		ctx.next();
		// Catch the error without changing state.
		this.reject.apply(null, arguments);
	}

	this.chain(_fallback, _errback);

	return ch;
};

Chain.prototype.aCall = function(call, context /* arguments */) {
	if( typeof call !== 'function' ) return this;

	var args = Array.prototype.slice.call(arguments);

	return this.chain(function() {
		this.aCall.apply(undefined, args);
	});
};

/**
 * @see nCall, Chain#aCall
 * @param {Function} call
 * @param {Object} [context]
 * @return {Chain}
 */
Chain.prototype.nCall = function nCall(call, context /* arguments */) {
	if( typeof call !== 'function' ) return this;

	var args = Array.prototype.slice.call(arguments);

	return this.chain(function(){
		this.nCall.apply(undefined, args);
	});
};

/**
 * Execute `func` when the Chain reaches this step with `context` and `params`. Sets the Chain's value to `func`'s
 * return value.
 * @param {Function} func
 * @param {Object} [context]
 * @param {...*} [params]
 * @return {Chain}
 */
Chain.prototype.cCall = function cCall(func, context, params) {
	params = Array.prototype.slice.call(arguments);

	return this.chain(function() {
		// TODO: Decide whether `func` returning undefined should be skipped or set the Chain's value to undefined.
		this.cCall.apply(undefined, params);
	});
};

Chain.prototype.spread = function spread(fallback, errback, noHijack) {
	function _callback(/*arguments*/) {
		var res;

		if( arguments.length === 1 ) {
			if( Array.isArray(arguments[0]) ) {
				res = arguments[0];
			}
			else {
				return arguments[0];
			}
		}
		else {
			res = Array.prototype.slice.call(arguments);
		}

		this.next.apply(undefined, res);
	}

	return this.chain(_callback).chain(fallback, errback, noHijack);
};

Chain.prototype.fail = Chain.prototype.error = function(errback, noHijack) {
	return this.chain(undefined, errback, noHijack);
};

Chain.prototype.fin = Chain.prototype['finally'] = function(finback, noHijack) {
	return this.chain(finback, finback, noHijack);
};

Chain.prototype.reject = function reject(reason) {
	return this.chain(function() {
		this.reject(reason);
	});
};

Chain.prototype.resolve = function() {
	if( this._pending.length === 0 || this._resolving ) {
		return;
	}

	this._resolving = true;

	var self = this;

	if( !this._immediate ) {
		nextTick(function() {
			resolve.call(self);
		});

		return this;
	}
	else {
		this._immediate = _immediate;
		resolve.call(this);

		return this;
	}

	function resolve(val /* arguments */) {
		var args = Array.prototype.slice.call(arguments);
		if( args.length === 0 /* || (args.length === 1 && args[0] === undefined)*/ ) {
			args = Array.isArray(this._value) ? this._value : [this._value];
		}
		else {
			this._value = args;
		}

		if( this._pending.length === 0 ) {
			this._resolving = false;
			return;
		}

		if( this._paused ) return;

		if( this._unPending.length ) {
			this._pending.unshift.apply(this._pending, this._unPending);
			this._unPending.length = 0;
		}
		var fns = this._pending.shift();

		if( this._report ) console.log('chain fns'+this._uid, fns[0] && fns[0].toString(), fns[1] && fns[1].toString());

		if( !(typeof fns[0] === 'function' || typeof fns[1] === 'function') ) {
			return resolve.apply(this, args);
		}

		var self = this
			, skip = false
			, nextOnce = false
			, value
			, fn
			, obj = {
				delay: delay
				, pause: delay
				, next: next
				, resume: next
				, chain: chain
				, fail: fail
				, aCall: aCall
				, nCall: nCall
				, cCall: cCall
				, reject: reject
				, _errors: this._errors
			};

		function delay() {
			if( skip ) return obj;
			skip = self._paused = true;
			return obj;
		}

		function next(/* arguments */) {
			if( nextOnce ) return obj;
			nextOnce = skip = !(self._paused = false);
			resolve.apply(self, arguments);
			return obj;
		}

		function chain(fallback, errback, noHijack) {
			_chain(self, fallback, errback, noHijack, true);

			return obj;
		}

		function fail(errback, noHijack) {
			_chain(self, undefined, errback, noHijack, true);

			return obj;
		}

		function aCall(call, context /* arguments */) {
			var args = Array.prototype.slice.call(arguments, 2);

			args.push(function(/* arguments */) {
				obj.resume.apply(undefined, arguments);
			});

			return obj.chain(function() {
				this.delay();
				call.apply(context, args);
			});
		}

		function nCall(call, context /* arguments */) {
			var args = Array.prototype.slice.call(arguments, 2)
				, self;

			if( typeof call !== 'function' ) {
				console.log('nCall', nCall.caller);
				throw new Error('`call` argument in nCall must be a function.');
			}

			args.push(function(err /* arguments */) {
				if( err ) return obj.reject(err);

				self.resume.apply(undefined, Array.prototype.slice.call(arguments, 1));
			});

			return obj.chain(function() {
				self = this.delay();
				call.apply(context, args);
			});
		}

		function cCall(func, context, params) {
			params = Array.prototype.slice.call(arguments, 2);

			return obj.chain(function() {
				return func.apply(context, params);
			});
		}

		function reject(reason) {
			if( !reason ) reason = new Error('No reason given');
			self._error = reason;
			return obj.next();
		}

		if( typeof this._error !== 'undefined' ) {
			if( typeof fns[1] !== 'function' ) return resolve.apply(this, args);

			self._errors.push(self._error);

			value = (function(){
				try {
					var val
						, args = fns[2] ? [obj, self._error] : [self._error];

					val = fns[1].apply(fns[2] ? undefined : obj, args);

					delete self._error;
					return val;
				}
				catch(e) {
					self._error = e;
				}
			})();

			if( typeof value === 'undefined' ) value = [self._error];
		}
		else {
			if( typeof fns[0] !== 'function' ) return resolve.apply(this, args);

			value = (function(){
				try {
					var a = args;

					if( fns[2] ) a = [obj].concat(args);

					if( !fns[0].apply ) console.log('chain problem', fns[0]);

					return fns[0].apply(fns[2] ? undefined : obj, a);
				}
				catch(e) {
					self._error = e;
					console.log('err', e && e.stack || e.message || e);
				}
			})();

			if( typeof value === 'undefined' ) value = [];
		}

		if( skip || this._paused || typeof this._error !== 'undefined' ) {
			return resolve.call(this);
		}

		if( this._report ) console.log('chain value'+this._uid, value);

		if( isChainable(value) ) {
			this._paused = true;
			value.chain(function(/* arguments */) {
				self._paused = false;
				resolve.apply(self, arguments);
			}, function(err) {
				self._paused = false;
				self._error = err;
				resolve.apply(self);

				// Attempt to observe this chain without changing its state.
				this.reject(err);
			});
		} else if( isThenable(value) ) {
			this._paused = true;
			value.then(function(/* arguments */){
				self._paused = false;
				resolve.apply(self, arguments);
			}, function(err) {
				self._paused = false;
				self._error = err;
				resolve.apply(self);
			});
		} else {
			if( typeof value !== 'undefined' ) this._value = value;

			resolve.apply(this, (Array.isArray(value)) ? value : [value]);
		}

		if( this._pending.length === 0 ) {
			this._resolving = false;
		}
	}
};

exports.all = all;
/**
 * Will wait for the current latest step in each {Chain} in `values` to complete before progressing.
 * @param {Array} values An array of {Chain}s.
 * @return {Chain}
 */
function all(values) {
	if( !Array.isArray(values) ) throw new Error('You must provide an Array to Chain#all.');

	var len = values.length
		, complete = 0
		, results = []
		, firstErr
		, errResults
		, ctx;

	if( !len ) return now();

	var ch = now(undefined, function(){ctx = this.delay();});

	results.length = len;

	function whenDone() {
		if( complete === len ) {
			if( errResults ) ctx.reject(firstErr, errResults);
			else ctx.resume.call(undefined, results);
		}
	}

	for( var i=0; i<len; i++ ) {
		if( !isThenable(values[i]) ) {
			results[i] = values[i];
			complete++;

			continue;
		}

		(function(k){
			var done = false
				, isC = isChainable(values[k]);

			values[k][isC?'chain':'then'](function(/* arguments */) {
				if( done ) return;

				complete++;
				done = true;

				results[k] = arguments.length > 1 ? Array.prototype.slice.call(arguments) : arguments[0];

				whenDone();

				if( isC ) return results[k];
			}, function(err) {
				if( done ) return;

				complete++;
				done = true;

				if( !firstErr ) firstErr = err;

				(errResults = errResults || [])[k] = err;

				whenDone();

				if( isC ) this.reject(err);
			});
		})(i);
	}

	if( complete === len ) whenDone();

	return ch;
}

exports.each = each;

/**
 * A shortcut for scheduling work on an array of values and waiting for all the work to complete.
 * @param {Array} values An array of items to work with.
 * @param {Function} worker A function to apply to each value.
 * @return {Chain}
 */
function each(values, worker) {
	var arr = [];

	for( var i= 0, len=values.length; i<len; i++ ) {
		arr.push(worker(values[i]));
	}

	return all(arr);
}

exports.start = start;
/**
 * Starts a new Chain.
 * @param {*} [value]
 * @param {Function} [fallback]
 * @param {Function} [errback]
 * @return {Chain}
 */
function start(value, fallback, errback) {
	return new Chain(value, fallback, errback);
}

exports.chain = chain;
/**
 * Creates a new chain with no starting value.
 * @param {Function} [fallback]
 * @param {Function} [errback]
 * @return {Chain}
 */
function chain(fallback, errback) {
	return start(undefined, fallback, errback);
}

exports.fail = exports.error = exports.reject = fail;
/**
 * Creates a new Chain already in an error state.
 * @param {*} err Should be truthy.
 * @return {Chain}
 */
function fail(err) {
	var ch = start();
	ch._error = err || new Error();
	return ch;
}

exports.aCall = aCall;
/**
 * Starts a new Chain that is waiting on the asynchronous completing of `call`. `call` will be executed with a callback
 * function as its final parameter, and the Chain will resume completion when this callback is called, using any
 * arguments it was given as the Chain's parameters.
 * @param {Function} call The function to execute asynchronously.
 * @param {Object} [context] The context to apply to `call`.
 * @param {...*} [params] Additional parameters to execute `call` with.
 * @return {Chain}
 */
function aCall(call, context /* params */) {
	var args = Array.prototype.slice.call(arguments);

	return now(undefined, function() {
		this.aCall.apply(this, args);
	});
}

exports.nCall = nCall;
/**
 * Is identical to aCall, except that the callback given to `call` expects an error as its first parameter. If this
 * first parameter is truthy, the Chain will resume in an error state. Otherwise, it will resume using any additional
 * parameters as its parameters.
 *
 * @see aCall
 *
 * @param {Function} call The function to execute asynchronously.
 * @param {Object} context The context to apply to `call`.
 * @param {...*} [params] Additional parameters to execute `call` with.
 * @return {Chain}
 */
function nCall(call, context /* arguments */) {
	var args = Array.prototype.slice.call(arguments);

	if( typeof call !== 'function' ) {
		throw new Error('The first parameter of nCall must be a function.');
	}

	return now(undefined, function() {
		this.nCall.apply(this, args);
	});
}

exports.now = now;
/**
 * Creates a new Chain that executes immediately rather than using nextTick.
 * @param {*} [value]
 * @param {Function} [fallback]
 * @param {Function} [errback]
 * @return {Chain}
 */
function now(value, fallback, errback) {
	return start({now:NOW, value:value}, fallback, errback);
	//return start(value, fallback, errback);
}