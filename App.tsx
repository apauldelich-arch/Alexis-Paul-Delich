
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, Message } from './types';
import { ITERO_SYSTEM_INSTRUCTION, WASTE_TYPES } from './constants';
import { decode, encode, decodeAudioData, createBlob } from './utils/audio';

// UI Components
const Header: React.FC = () => (
  <header className="flex items-center justify-between p-6 bg-[#0f172a]/80 backdrop-blur-md border-b border-slate-800 sticky top-0 z-50">
    <div className="flex items-center gap-4">
      <div className="flex items-center">
        {/* Itero-inspired Logo Representation */}
        <div className="relative flex items-center justify-center mr-3">
          <div className="w-10 h-10 bg-[#FE5733] rounded-lg rotate-12 absolute opacity-20"></div>
          <div className="w-10 h-10 bg-[#981600] rounded-lg -rotate-6 absolute opacity-40"></div>
          <div className="w-10 h-10 bg-[#FE5733] rounded-lg flex items-center justify-center relative shadow-lg shadow-[#FE5733]/20">
            <i className="fa-solid fa-infinity text-white text-xl"></i>
          </div>
        </div>
        <div>
          <h1 className="text-2xl font-black text-white tracking-tighter leading-none">
            ITERO<span className="text-[#FE5733]">TECH</span>
          </h1>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] mt-1">Circular Systems</p>
        </div>
      </div>
    </div>
    <div className="hidden md:flex items-center gap-8">
      <nav className="flex gap-6 text-sm font-semibold text-slate-400">
        <a href="https://www.itero-tech.com/technology" target="_blank" className="hover:text-[#FE5733] transition-colors">Technology</a>
        <a href="https://www.itero-tech.com/wlpp" target="_blank" className="hover:text-[#FE5733] transition-colors">WLPP</a>
        <a href="https://www.itero-tech.com/contact" target="_blank" className="hover:text-[#FE5733] transition-colors">Contact</a>
      </nav>
      <div className="h-6 w-[1px] bg-slate-800"></div>
      <span className="px-4 py-1.5 bg-[#FE5733]/10 text-[#FE5733] rounded-full text-xs font-bold border border-[#FE5733]/30 tracking-wider">
        VOICE ASSISTANT
      </span>
    </div>
  </header>
);

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [transcriptionHistory, setTranscriptionHistory] = useState<Message[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [currentInputText, setCurrentInputText] = useState('');
  const [currentOutputText, setCurrentOutputText] = useState('');

  // Refs for Audio
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const appendToHistory = useCallback((role: 'user' | 'model', text: string) => {
    if (!text.trim()) return;
    setTranscriptionHistory(prev => [...prev, { role, text, timestamp: new Date() }]);
  }, []);

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    setStatus(ConnectionStatus.DISCONNECTED);
    setCurrentInputText('');
    setCurrentOutputText('');
  }, []);

  const startSession = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputNodeRef.current = outputAudioContextRef.current.createGain();
      outputNodeRef.current.connect(outputAudioContextRef.current.destination);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: ITERO_SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (isMuted) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNodeRef.current!);
              source.onended = () => sourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              setCurrentInputText(prev => prev + message.serverContent!.inputTranscription!.text);
            }
            if (message.serverContent?.outputTranscription) {
              setCurrentOutputText(prev => prev + message.serverContent!.outputTranscription!.text);
            }

            if (message.serverContent?.turnComplete) {
              setCurrentInputText(text => {
                if (text) appendToHistory('user', text);
                return '';
              });
              setCurrentOutputText(text => {
                if (text) appendToHistory('model', text);
                return '';
              });
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Session error:', e);
            setStatus(ConnectionStatus.ERROR);
            stopSession();
          },
          onclose: () => {
            setStatus(ConnectionStatus.DISCONNECTED);
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('Failed to start session:', err);
      setStatus(ConnectionStatus.ERROR);
    }
  };

  const toggleMute = () => setIsMuted(!isMuted);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <Header />

      <main className="flex-1 max-w-6xl w-full mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Sidebar Info */}
        <div className="space-y-6">
          <section className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 shadow-xl">
            <h2 className="text-xs font-black text-[#FE5733] uppercase tracking-[0.2em] mb-4">Plant Status: WLPP</h2>
            <div className="space-y-4">
              <div className="flex justify-between items-center text-sm">
                <span className="text-slate-400 font-medium">West London Pilot Plant</span>
                <span className="text-[#FE5733] font-bold flex items-center gap-2">
                  <span className="w-2 h-2 bg-[#FE5733] rounded-full animate-pulse shadow-[0_0_8px_#FE5733]"></span> Online
                </span>
              </div>
              <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-[#FE5733] w-3/4 rounded-full shadow-[0_0_10px_rgba(254,87,51,0.4)]"></div>
              </div>
              <p className="text-[13px] text-slate-400 leading-relaxed font-medium">
                Verified chemical recycling output for PP/PE/PS waste streams. Modular design scale-up phase active.
              </p>
            </div>
          </section>

          <section className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 shadow-xl">
            <h2 className="text-xs font-black text-[#FE5733] uppercase tracking-[0.2em] mb-4">Target Feedstock</h2>
            <ul className="grid grid-cols-1 gap-2">
              {WASTE_TYPES.map((type, idx) => (
                <li key={idx} className="flex items-center gap-3 text-[13px] text-slate-300 font-medium p-2 rounded-lg bg-slate-800/30 hover:bg-[#FE5733]/10 transition-colors group">
                  <i className="fa-solid fa-circle-check text-[#FE5733] opacity-60 group-hover:opacity-100 transition-opacity"></i>
                  {type}
                </li>
              ))}
            </ul>
          </section>

          <section className="bg-[#981600]/10 rounded-2xl p-6 border border-[#981600]/20 shadow-xl">
            <h2 className="text-xs font-black text-white uppercase tracking-[0.2em] mb-4">Core Innovation</h2>
            <div className="space-y-3 text-[13px] text-slate-400 font-medium">
              <div className="flex gap-3">
                <div className="w-1.5 h-1.5 bg-[#FE5733] rounded-full mt-1.5 shrink-0"></div>
                <p><span className="text-slate-200">Itero-Oil™:</span> Superior quality pyrolysis oil for new plastic production.</p>
              </div>
              <div className="flex gap-3">
                <div className="w-1.5 h-1.5 bg-[#FE5733] rounded-full mt-1.5 shrink-0"></div>
                <p><span className="text-slate-200">Modular Design:</span> Rapid deployment and localized waste processing.</p>
              </div>
            </div>
          </section>
        </div>

        {/* Voice Interface */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          <div className="bg-slate-900/40 rounded-[2.5rem] flex-1 flex flex-col border border-slate-800 overflow-hidden relative min-h-[500px] shadow-2xl backdrop-blur-sm">
            {/* Visualizer Area */}
            <div className="flex-1 flex flex-col items-center justify-center p-8 relative">
              <div className={`w-56 h-56 rounded-full flex items-center justify-center transition-all duration-700 ${
                status === ConnectionStatus.CONNECTED ? 'bg-[#FE5733]/5' : 'bg-slate-800/50'
              }`}>
                <div className={`w-36 h-36 rounded-full flex items-center justify-center transition-all duration-700 relative z-10 ${
                  status === ConnectionStatus.CONNECTED 
                    ? 'bg-gradient-to-br from-[#FE5733] to-[#981600] shadow-[0_0_60px_rgba(254,87,51,0.3)] scale-110' 
                    : 'bg-slate-700'
                }`}>
                  <i className={`fa-solid ${status === ConnectionStatus.CONNECTED ? 'fa-microphone' : 'fa-phone-flip'} text-5xl ${
                    status === ConnectionStatus.CONNECTED ? 'text-white' : 'text-slate-400 opacity-50'
                  }`}></i>
                </div>
                {status === ConnectionStatus.CONNECTED && (
                  <>
                    <div className="absolute w-44 h-44 border-2 border-[#FE5733]/40 rounded-full animate-ping opacity-20"></div>
                    <div className="absolute w-64 h-64 border border-[#FE5733]/20 rounded-full animate-pulse"></div>
                    <div className="absolute w-[18rem] h-[18rem] border border-[#981600]/10 rounded-full"></div>
                  </>
                )}
              </div>

              <div className="mt-12 text-center z-10">
                <h3 className="text-2xl font-bold mb-2 text-white">
                  {status === ConnectionStatus.CONNECTED ? 'System Online' : 
                   status === ConnectionStatus.CONNECTING ? 'Connecting to WLPP...' :
                   status === ConnectionStatus.ERROR ? 'Connection Error' : 'Customer Service Agent'}
                </h3>
                <p className="text-slate-400 font-medium max-w-sm mx-auto leading-relaxed">
                  {status === ConnectionStatus.CONNECTED ? 'Monitoring audio input. How can Itero support your plastic waste inquiry today?' : 
                   'Ready to assist with technology details, feed testing, and site visits at our West London facility.'}
                </p>
              </div>

              {/* Real-time transcription bubble */}
              {(currentInputText || currentOutputText) && (
                <div className="absolute bottom-10 left-10 right-10 bg-[#0f172a]/90 backdrop-blur-xl p-6 rounded-[1.5rem] border border-[#FE5733]/30 shadow-2xl animate-in fade-in slide-in-from-bottom-6 duration-500">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-1.5 h-1.5 bg-[#FE5733] rounded-full animate-pulse"></span>
                    <span className="text-[10px] font-black text-[#FE5733] uppercase tracking-[0.2em]">Live Feed</span>
                  </div>
                  <div className="text-[15px] font-medium leading-relaxed">
                    {currentInputText && <span className="text-slate-400 italic">"{currentInputText}"</span>}
                    {currentOutputText && <span className="text-white block mt-2">{currentOutputText}</span>}
                  </div>
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="p-10 bg-slate-900/60 border-t border-slate-800 flex items-center justify-center gap-8">
              <button 
                onClick={toggleMute}
                disabled={status !== ConnectionStatus.CONNECTED}
                className={`w-14 h-14 rounded-2xl flex items-center justify-center border-2 transition-all duration-300 ${
                  isMuted ? 'bg-[#981600]/20 border-[#981600]/50 text-[#FE5733]' : 'bg-slate-800/50 border-slate-700 text-slate-300 hover:border-[#FE5733]/50'
                } disabled:opacity-20`}
              >
                <i className={`fa-solid ${isMuted ? 'fa-microphone-slash' : 'fa-microphone'} text-xl`}></i>
              </button>

              <button 
                onClick={status === ConnectionStatus.CONNECTED ? stopSession : startSession}
                className={`px-12 py-4 rounded-2xl font-black text-sm uppercase tracking-widest transition-all duration-300 flex items-center gap-4 shadow-2xl ${
                  status === ConnectionStatus.CONNECTED 
                    ? 'bg-[#981600] hover:bg-[#7a1200] text-white shadow-[#981600]/20' 
                    : 'bg-[#FE5733] hover:bg-[#e44d2d] text-white shadow-[#FE5733]/30'
                }`}
              >
                <i className={`fa-solid ${status === ConnectionStatus.CONNECTED ? 'fa-phone-slash' : 'fa-headset'} text-lg`}></i>
                {status === ConnectionStatus.CONNECTED ? 'Disconnect' : 'Connect Now'}
              </button>

              <button className="w-14 h-14 rounded-2xl flex items-center justify-center bg-slate-800/50 border-2 border-slate-700 text-slate-300 hover:border-[#FE5733]/50 transition-all">
                <i className="fa-solid fa-sliders text-xl"></i>
              </button>
            </div>
          </div>

          {/* Transcript History */}
          <div className="bg-slate-900/40 rounded-[2rem] p-8 border border-slate-800 flex-1 min-h-[250px] flex flex-col shadow-xl">
            <h4 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] mb-6 flex items-center gap-3">
              <div className="w-1 h-4 bg-[#FE5733] rounded-full"></div>
              Session Conversation Log
            </h4>
            <div className="space-y-6 overflow-y-auto max-h-[400px] pr-4 custom-scrollbar">
              {transcriptionHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-600 gap-3">
                  <i className="fa-solid fa-comment-dots text-3xl opacity-20"></i>
                  <p className="text-sm font-medium italic">Waiting for connection activity...</p>
                </div>
              ) : (
                transcriptionHistory.map((msg, i) => (
                  <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2`}>
                    <div className={`max-w-[85%] p-4 rounded-3xl text-[14px] font-medium leading-relaxed ${
                      msg.role === 'user' 
                        ? 'bg-slate-800 text-slate-200 rounded-tr-none' 
                        : 'bg-[#FE5733]/10 text-white border border-[#FE5733]/20 rounded-tl-none'
                    }`}>
                      {msg.text}
                    </div>
                    <span className="text-[10px] font-black text-slate-600 mt-2 uppercase tracking-tighter">
                      {msg.role === 'user' ? 'Client' : 'Itero Assistant'} • {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="p-10 bg-slate-950 border-t border-slate-900">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="text-center md:text-left">
            <h5 className="text-white font-black text-sm tracking-tighter mb-1 uppercase">Itero Technologies Ltd</h5>
            <p className="text-slate-600 text-xs font-medium uppercase tracking-widest">Pioneering a world where no plastic is wasted.</p>
          </div>
          <div className="flex gap-8 text-slate-500">
            <a href="#" className="hover:text-[#FE5733] transition-colors"><i className="fa-brands fa-linkedin text-xl"></i></a>
            <a href="#" className="hover:text-[#FE5733] transition-colors"><i className="fa-brands fa-x-twitter text-xl"></i></a>
            <a href="#" className="hover:text-[#FE5733] transition-colors"><i className="fa-brands fa-vimeo text-xl"></i></a>
          </div>
        </div>
        <div className="mt-8 text-center text-[10px] font-black text-slate-700 uppercase tracking-[0.3em]">
          Copyright 2024 • All Rights Reserved
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 20px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #334155; }
      `}</style>
    </div>
  );
};

export default App;
