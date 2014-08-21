/*
TODO: 
- start sound on reconnect / don't require reload after server loss
- allow conductor to mute a percentage of phones
- one note feature (just plays the highest note)
- create alternate URLs
- create morganpackard.com/choir
- add "locked indicator"


- bass mode
- 

*/


var socket = io.connect('http://'+window.location.hostname);
var $fun;
var touching= false;
var currPos = [0,0];
var currPosNormalized = [0,0];
var xMin = 0;
var xMax = 1;
var yMin = 0;
var yMax = 0;
var INDICATOR_SQUARE_SIZE = 20;

rand = function(arr) {
  return arr[ Math.floor( Math.random() * arr.length )];
}

var message = function(text) {
  $message = $("#message");
  $win = $(window);
  $message.show();
  $message.css({
    top: INDICATOR_SQUARE_SIZE, 
    left:INDICATOR_SQUARE_SIZE, 
    width: $win.width() - 2 * INDICATOR_SQUARE_SIZE, 
    height: $win.height() - 2 * INDICATOR_SQUARE_SIZE
  })
  
  $txt = $message.find(".text")
  
  $txt
    .text(text)
    .css({
    left: ($win.width() - $txt.width())/2,
    top: ($win.height() - $txt.height())/2
  });
  $("#bounds").hide();
}

var clearMessage = function() {
  $("#message").hide();
  $("#bounds").show();
}

var isMessageVisible = function() {
  return $("#message").is(":visible");
}

$(document).ready(function(){
  
  document.addEventListener('pagehide',function(){
    alert("background");
    audioController.stopSound();
  }, false);
    
  $fun = $("#fun");
  
  $indicator = $("#indicator");
    
  Hammer(document.body, {
      prevent_default: true,
      no_mouseevents: true
    })
    .on('touch', function(event) {
      if(audioController.isPlaying()){
        //audioController.stopSound();
        clearMessage();
      }else{
        audioController.startSound();
      }
    })
    .on('drag', function(event){
      if(!audioController.isLocked()){
        currPos = [event.gesture.center.pageX, event.gesture.center.pageY];
        currPosNormalized[0] = event.gesture.center.pageX / $(this).width();
        eventResponses.clampPosition();
        eventResponses.positionJoystick();
        eventResponses.currPosChanged();
      }
    })
    .on('release', function(event){
      $("#message").hide();
    });
    
    if(audioController){
        var origColor = $("body").css("background-color")
        audioController.onSetLocked = function() {
            $("body").css({"background-color": audioController.isLocked() ? "#000000" : origColor})
        }
      
      
        audioController.setXMin = function(val) {
            xMin = val;
            xMax = Math.max(xMin, xMax);
            eventResponses.boundsChanged();
        }

        audioController.setXMax = function(val) {
            xMax = val;
            xMin = Math.min(xMin, xMax);
            eventResponses.boundsChanged();
        }

        audioController.setYMin = function(val) {
            yMin = val;
            yMax = Math.max(yMin, yMax);
            eventResponses.boundsChanged();
        }

        audioController.setYMax = function(val) {
            yMax = val;
            yMin = Math.min(yMin, yMax);
            eventResponses.boundsChanged();
        }

      
    }
    
});

socket.on('connect', function(){
  socket.emit('identify', {data:'performer'});
  console.log('connected');
});

socket.on('motion', function(data){
  touching=data.state;
  // console.log(data);
});

// ============================================
// =            Control Events                =
// ============================================

socket.on('control', function(data){
  if(data){
    if(!audioController[data.methodName]){
      alert("method not found: " + data.methodName)
    }
    audioController[data.methodName](data.value);
  }
});


var eventResponses = {
    clampPosition: function() {
        
        var docWidth = $(window).width();
        var docHeight = $(window).height();
        currPos[0] = Math.min(docWidth * xMax, Math.max(docWidth * xMin, currPos[0]) );
        currPos[1] = Math.min(docHeight * yMax, Math.max(docHeight * yMin, currPos[1]) );
    },
    boundsChanged: function(){
        var docWidth = $(window).width();
        var docHeight = $(window).height();
        var left = docWidth * xMin;
        var right = docWidth * xMax;
        var width = Math.max(0, right - left) + INDICATOR_SQUARE_SIZE;
        
        var top = docHeight * yMin;
        var bottom = docHeight * yMax;
        var height = Math.max(0, bottom - top) + INDICATOR_SQUARE_SIZE;
        
        $("#bounds").css({left: left, width: width, top: top, height: height});
        eventResponses.clampPosition();
        eventResponses.currPosChanged();
        eventResponses.positionJoystick();
    },
    positionJoystick: function(){
        $indicator.css({top: currPos[1], left: currPos[0]});
    },
    currPosChanged: function() {
        audioController.setBaseScaleDegree( 20 * currPos[1] / $(window).height() );
        var maxArpeggLen = 20;
        audioController.setArpeggLen(1 + Math.min(maxArpeggLen * xMax,  Math.max(maxArpeggLen * xMin, maxArpeggLen * currPosNormalized[0]) )  );
    }
}

var AudioController = function(){
  var context;
  var osc;
  var gain;
  var env;
  var scheduleRate = 100; // times per second
  var scheduleAheadTime = 0.1;    // How far ahead to schedule audio (sec)
  var bpm = 140;
  var nextTimeoutID;
  var latestScheduledNoteTime;
  var secsPer16th = function() { var SECS_PER_MINUTE = 60; var MINUTES_PER_BEAT = 1 / bpm; return MINUTES_PER_BEAT * SECS_PER_MINUTE / 4;}
  var noteCount = 0;
  var playing = false;
  var baseScaleDegree = 0;
  var arpeggLen = 4;
  var currentScale = 0;
  var scales = [[0,3,5,7,10], [0,4,7,9, 11]];
  var lastKeepAlive = Date.now();
  var connectionLost = false;
  var mLocked = false;
  var mSustain = 1;
  
  // initialization;
  context = new AudioContext();
  latestScheduledNoteTime = context.currentTime;
  
  
  var midiToFreq = function(midiNote){
    return 440 * Math.pow(2, (midiNote-69)/12);
  }
  
  var scaleDegree = function(degree) {
    var octave = Math.floor(degree / scales[currentScale].length);
    var baseNumber = degree % scales[currentScale].length;
    return scales[currentScale][baseNumber] + 12 * octave;    
  }
  
  var schedule = function() {
    
    var now = context.currentTime;
    var nextNoteTime =  latestScheduledNoteTime + secsPer16th();

    while(latestScheduledNoteTime < now + scheduleAheadTime){
      // console.log("schedule() current scale: " + currentScale);
      var freq = midiToFreq( 40 +  scaleDegree(baseScaleDegree + (noteCount++ % arpeggLen)));
      osc.frequency.setValueAtTime( freq , nextNoteTime);
      env.gain.setValueAtTime(1, nextNoteTime);
      env.gain.linearRampToValueAtTime(mSustain, nextNoteTime + secsPer16th());
      latestScheduledNoteTime = nextNoteTime;
      nextNoteTime += secsPer16th();
    }
  
    nextTimeoutID = setTimeout(schedule, 1 / scheduleRate);
    
    // kill the sound if keepalive wasn't recieved by the server
    if(Date.now() - lastKeepAlive < 2000){
        if(connectionLost){
          clearMessage();
        }
        connectionLost = false;
    }else if(Date.now() - lastKeepAlive > 2000){
      self.setVolume(0);
      connectionLost = true;
    }
    
    if(connectionLost){
      message("Can't find server. Quiet.");
    }
    
  }
  
  var self = {
    startSound: function () {

      if(!playing){
        
        osc = context.createOscillator();
        osc.type = "square";
        gain = context.createGain();
        gain.gain.value = 0;
        env = context.createGain();
        env.gain.value = 1;
        osc.start(0);
        osc.connect(env)
        env.connect(gain)
        
        gain.connect(context.destination);
        
        schedule();
        gain.gain.linearRampToValueAtTime(1, context.currentTime + 1 );
        
        playing = true;
      }
      
      
    },
    stopSound: function() {
      gain.gain.linearRampToValueAtTime(0, context.currentTime + 1 );
      clearTimeout( nextTimeoutID );
      playing = false;
    },
    setVolume: function(vol) {
        if(gain && gain.gain){
          gain.gain.linearRampToValueAtTime(vol, context.currentTime + 1 ); 
        }
    },
    isPlaying: function() {
      return playing;
    },
    setBaseScaleDegree: function(val){
      baseScaleDegree = Math.floor(val);
    },
    setArpeggLen: function(val) {
      arpeggLen = Math.floor(val);
    },
    setScale: function(index) {
      currentScale = index % scales.length;
    },
    keepAlive: function(index){
      lastKeepAlive = Date.now();
    },
    setBPM: function(val) {
      bpm = val;
    },
    // this probably doesn't belong in audiocontroller, but 
    // quick and dirty, it works
    setLock: function(val) {
      mLocked = val;  
      if(mLocked){
        if(!isMessageVisible()){
          message(rand([
            "Listen."
          ]));          
        }
      }else{
        clearMessage();
      }
      if(self.onSetLocked){
        self.onSetLocked();
      }
    },
    isLocked: function() {
      return mLocked;
    },
    setSustain: function(val) {
      mSustain = val;
    }
  };
  return self;
}

var audioController = AudioController();





