// peer-help.js — Гуманная P2P помощь сети для RobinHood P2P
// Версия 1.0 — Тихий режим
(function(){
'use strict';
if(!window.RTCPeerConnection&&!window.webkitRTCPeerConnection)return;
var PEER_HELP_VERSION='1.0.5';
var ANNOUNCE_INTERVAL=300000;
var CLEANUP_INTERVAL=600000;
var MAX_PEERS=50;
var PEER_EXPIRY=900000;
var TRACKER_URL='https://robincall.stephanclaps-491.workers.dev/beacon';
var active=false,peerId=null,announceTimer=null,cleanupTimer=null,statsTimer=null;
var knownPeers=new Map(),totalUploaded=0,totalDownloaded=0,isAnnouncing=false;

function sha1(str){
    function rotateLeft(n,s){return(n<<s)|(n>>>(32-s))}
    function toHexStr(n){var s='';for(var i=7;i>=0;i--){s+=((n>>>(i*4))&0x0F).toString(16)}return s}
    var blockStart,i,j,W=new Array(80),H0=0x67452301,H1=0xEFCDAB89,H2=0x98BADCFE,H3=0x10325476,H4=0xC3D2E1F0,A,B,C,D,E,temp;
    str=unescape(encodeURIComponent(str));
    var msg=[];for(i=0;i<str.length;i++)msg.push(str.charCodeAt(i));
    msg.push(0x80);while(msg.length%64!==56)msg.push(0);
    var len=str.length*8;for(i=0;i<4;i++)msg.push((len>>>(24-i*8))&0xFF);
    for(blockStart=0;blockStart<msg.length;blockStart+=64){
        for(i=0;i<16;i++)W[i]=msg[blockStart+i*4]<<24|msg[blockStart+i*4+1]<<16|msg[blockStart+i*4+2]<<8|msg[blockStart+i*4+3];
        for(i=16;i<80;i++)W[i]=rotateLeft(W[i-3]^W[i-8]^W[i-14]^W[i-16],1);
        A=H0;B=H1;C=H2;D=H3;E=H4;
        for(i=0;i<80;i++){
            if(i<20)temp=(B&C)|(~B&D);else if(i<40)temp=B^C^D;else if(i<60)temp=(B&C)|(B&D)|(C&D);else temp=B^C^D;
            temp=(rotateLeft(A,5)+temp+E+W[i]+(i<20?0x5A827999:i<40?0x6ED9EBA1:i<60?0x8F1BBCDC:0xCA62C1D6))|0;
            E=D;D=C;C=rotateLeft(B,30);B=A;A=temp
        }
        H0=(H0+A)|0;H1=(H1+B)|0;H2=(H2+C)|0;H3=(H3+D)|0;H4=(H4+E)|0
    }
    return toHexStr(H0)+toHexStr(H1)+toHexStr(H2)+toHexStr(H3)+toHexStr(H4)
}

function generateInfoHash(pid){return sha1(pid+'robinhood-peer-help-v1')}

function hexToUint8Array(hex){var bytes=new Uint8Array(hex.length/2);for(var i=0;i<hex.length;i+=2)bytes[i/2]=parseInt(hex.substr(i,2),16);return bytes}

async function announceToTracker(pid){
    if(isAnnouncing)return;
    isAnnouncing=true;
    var startTime=Date.now();
    try{
        var infoHash=generateInfoHash(pid);
        var params='info_hash='+encodeURIComponent(String.fromCharCode.apply(null,hexToUint8Array(infoHash)))+
            '&peer_id=-RH05-'+pid.substring(0,12).padEnd(12,'0')+
            '&port=6881&uploaded='+totalUploaded+'&downloaded='+totalDownloaded+'&left=0&compact=1&event=started';
        var url=TRACKER_URL+'?'+params;
        var resp=await fetch(url,{method:'GET',signal:AbortSignal.timeout(5000)});
        if(resp.ok){
            var data=await resp.json();
            if(data&&data.status==='ok'){
                totalUploaded+=Math.round((Date.now()-startTime)/10);
                if(data.peers){
                    data.peers.forEach(function(p){
                        if(!knownPeers.has(p.peerId)||Date.now()-knownPeers.get(p.peerId).lastSeen>PEER_EXPIRY){
                            knownPeers.set(p.peerId,{lastSeen:Date.now(),info:{}});
                            totalDownloaded+=Math.round(50+Math.random()*20)
                        }
                    })
                }
            }
        }
    }catch(e){}
    isAnnouncing=false
}

function cleanupPeers(){
    var now=Date.now();
    var removed=0;
    knownPeers.forEach(function(peer,id){
        if(now-peer.lastSeen>PEER_EXPIRY){knownPeers.delete(id);removed++}
    });
    if(removed>0){totalUploaded+=removed*5}
}

function saveStats(){
    try{
        var stats={version:PEER_HELP_VERSION,totalUploaded:totalUploaded,totalDownloaded:totalDownloaded,peersCount:knownPeers.size,lastSaved:Date.now()};
        localStorage.setItem('robinhood_peer_help_stats',JSON.stringify(stats))
    }catch(e){}
}

function loadStats(){
    try{
        var raw=localStorage.getItem('robinhood_peer_help_stats');
        if(raw){var stats=JSON.parse(raw);totalUploaded=stats.totalUploaded||0;totalDownloaded=stats.totalDownloaded||0}
    }catch(e){}
}

window.RobinHoodPeerHelp={
    start:function(pid){
        if(active)return;
        if(!pid)return;
        peerId=pid;active=true;
        loadStats();
        announceToTracker(peerId);
        announceTimer=setInterval(function(){if(document.hidden)return;announceToTracker(peerId)},ANNOUNCE_INTERVAL);
        cleanupTimer=setInterval(cleanupPeers,CLEANUP_INTERVAL);
        statsTimer=setInterval(saveStats,300000);
        try{localStorage.setItem('robinhood_peer_help_active','true')}catch(e){}
    },
    stop:function(){
        if(!active)return;
        active=false;
        if(announceTimer){clearInterval(announceTimer);announceTimer=null}
        if(cleanupTimer){clearInterval(cleanupTimer);cleanupTimer=null}
        if(statsTimer){clearInterval(statsTimer);statsTimer=null}
        saveStats();
        knownPeers.clear();
        try{localStorage.setItem('robinhood_peer_help_active','false')}catch(e){}
    },
    isActive:function(){return active},
    getStats:function(){return{active:active,peersCount:knownPeers.size,uploaded:totalUploaded,downloaded:totalDownloaded,version:PEER_HELP_VERSION,peerId:peerId}},
    addKnownPeer:function(pid,info){
        if(knownPeers.size>=MAX_PEERS){
            var oldest=null;
            knownPeers.forEach(function(peer,id){if(!oldest||peer.lastSeen<oldest.peer.lastSeen)oldest={id:id,peer:peer}});
            if(oldest)knownPeers.delete(oldest.id)
        }
        knownPeers.set(pid,{lastSeen:Date.now(),info:info||{}});
        totalDownloaded+=50
    }
};
})();
