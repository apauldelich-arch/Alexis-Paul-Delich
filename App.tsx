
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, Message } from './types.ts';
import { ITERO_SYSTEM_INSTRUCTION, WASTE_TYPES } from './constants.ts';
import { decode, encode, decodeAudioData, createBlob } from './utils/audio.ts';

const IteroLogo = ({ className = "w-10 h-10" }: { className?: string }) => (
  <svg viewBox="0 0 100 100" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M50 10C27.9 10 10 27.9 10 50C10 72.1 27.9 90 50 90C72.1 90 90 72.1 90 50" stroke="#FE5733" strokeWidth="12" strokeLinecap="round" />
    <path d="M90 50C90 27.9 72.1 10 50 10" stroke="#981600" strokeWidth="12" strokeLinecap="round" />
    <circle cx="50" cy="50" r="15" fill="#FE5733">
      <animate attributeName="r" values="12;16;12" dur="3s" repeatCount="indefinite" />
    </circle>
  </svg>
);

const Header: React.FC = () => (
  <header className="flex items-center justify-between p-4 md:p-6 bg-slate-950/80 backdrop-blur-md border-b border-slate-800 sticky top-0 z-50">
    <div className="flex items-center gap-3">
      <IteroLogo className="w-10 h-10 md:w-12 md:h-12 drop-shadow-[0_0_10px_rgba(254,87,51,0.3)]" />
      <div>
        <h1 className="text-xl md:text-2xl font-black text-white tracking-tighter leading-none">
          ITERO<span className="text-[#FE5733]">TECH</span>
        </h1>
        <p className="text-[9px] md:text-[10px] text-slate-500 font-bold uppercase tracking-[0.2em] mt-1">Circular Economy Systems</p>
      </div>
    </div>
    <div className="flex items-center gap-4">
      <div className="hidden lg:flex items-center gap-6 text-xs font-bold text-slate-500 uppercase tracking-widest mr-4">
        <a href="#" className="hover:text-[#FE5733] transition-colors">Technology</a>
        <a href="#" className="hover:text-[#FE5733] transition-colors">WLPP</a>
      </div>
      <div className={`px-3 py-1 rounded-full text-[10px] font-black tracking-tighter border ${process.env.API_KEY ? 'border-emerald-500/30 text-emerald-500' : 'border-red-500/30 text-red-500'}`}>
        {process.env.API_KEY ? 'CORE READY' : 'CORE OFFLINE'}
      </div>
    </div>
  </header>
);

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [transcriptionHistory, setTranscriptionHistory] = useState<Message[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [currentInputText, setCurrentInputText] = useState('');
  const [currentOutputText, setCurrentOutputText] = useState('');

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

  // Fix: Added missing toggleMute function
  const toggleMute = useCallback(() => {
    setIsMuted(prev => !prev);
  }, []);

  const stopSession = useCallback(() => {
    if (sessionRef.current) sessionRef.current.close();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (inputAudioContextRef.current) inputAudioContextRef.current.close();
    if (outputAudioContextRef.current) outputAudioContextRef.current.close();
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    setStatus(ConnectionStatus.DISCONNECTED);
    setCurrentInputText('');
    setCurrentOutputText('');
  }, []);

  const startSession = async () => {
    try {
      if (!process.env.API_KEY) throw new Error("API Key configuration missing.");
      
      setStatus(ConnectionStatus.CONNECTING);
      setErrorDetail(null);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioCtx({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioCtx({ sampleRate: 24000 });
      await inputAudioContextRef.current!.resume();
      await outputAudioContextRef.current!.resume();

      outputNodeRef.current = outputAudioContextRef.current!.createGain();
      outputNodeRef.current.connect(outputAudioContextRef.current!.destination);

      // Create a new GoogleGenAI instance right before making an API call to ensure it uses the latest configuration.
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
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
              // CRITICAL: Solely rely on sessionPromise resolves and then call `session.sendRealtimeInput`
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
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
            if (message.serverContent?.inputTranscription) setCurrentInputText(prev => prev + message.serverContent!.inputTranscription!.text);
            if (message.serverContent?.outputTranscription) setCurrentOutputText(prev => prev + message.serverContent!.outputTranscription!.text);
            if (message.serverContent?.turnComplete) {
              setCurrentInputText(t => { if (t) appendToHistory('user', t); return ''; });
              setCurrentOutputText(t => { if (t) appendToHistory('model', t); return ''; });
            }
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            setErrorDetail("Interface connection failed. Retrying...");
            setStatus(ConnectionStatus.ERROR);
            stopSession();
          },
          onclose: () => setStatus(ConnectionStatus.DISCONNECTED)
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setStatus(ConnectionStatus.ERROR);
      setErrorDetail(err.message || "Failed to start voice interface.");
      stopSession();
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100 font-sans">
      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-8 flex flex-col lg:flex-row gap-6 md:gap-8">
        {/* Left Stats Column */}
        <div className="lg:w-1/3 space-y-6">
          <section className="bg-slate-900/60 rounded-3xl p-6 border border-slate-800 shadow-2xl relative overflow-hidden">
            <h2 className="text-[10px] font-black text-[#FE5733] uppercase tracking-[0.2em] mb-4">Plant Monitoring: WLPP</h2>
            <div className="flex justify-between items-center mb-4">
              <span className="text-sm text-slate-400 font-bold">Pilot Stream Alpha</span>
              <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-500 text-[10px] font-black rounded border border-emerald-500/20 animate-pulse">LIVE DATA</span>
            </div>
            <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden mb-4">
              <div className="h-full bg-gradient-to-r from-[#FE5733] to-emerald-500 w-[84%] rounded-full shadow-[0_0_10px_rgba(16,185,129,0.3)]"></div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-950/40 p-3 rounded-2xl border border-white/5">
                <p className="text-[9px] text-slate-500 font-bold uppercase mb-1">Conversion</p>
                <p className="text-lg font-black text-white">84.2%</p>
              </div>
              <div className="bg-slate-950/40 p-3 rounded-2xl border border-white/5">
                <p className="text-[9px] text-slate-500 font-bold uppercase mb-1">Temp (C)</p>
                <p className="text-lg font-black text-white">420°</p>
              </div>
            </div>
          </section>

          <section className="bg-slate-900/40 rounded-3xl p-6 border border-slate-800">
            <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-4">Approved Feedstocks</h2>
            <div className="space-y-2">
              {WASTE_TYPES.map((type, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-slate-950/30 rounded-xl border border-white/5 text-xs font-bold text-slate-300">
                  <i className="fa-solid fa-recycle text-[#FE5733]"></i>
                  {type}
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Center Interface Column */}
        <div className="lg:w-2/3 flex flex-col gap-6">
          <div className="bg-slate-900/60 rounded-[2.5rem] border border-slate-800 flex flex-col shadow-2xl relative overflow-hidden">
            <div className="absolute inset-0 opacity-[0.05] pointer-events-none bg-[radial-gradient(#FE5733_1px,transparent_0)] bg-[size:30px_30px]"></div>
            
            {/* Visualizer Area */}
            <div className="flex-1 flex flex-col items-center justify-center p-12 min-h-[350px]">
              <div className="relative group">
                <div className={`w-48 h-48 md:w-56 md:h-56 rounded-full flex items-center justify-center transition-all duration-1000 ${
                  status === ConnectionStatus.CONNECTED ? 'bg-[#FE5733]/10 shadow-[0_0_60px_rgba(254,87,51,0.2)]' : 'bg-slate-800/50'
                }`}>
                  <div className={`w-32 h-32 md:w-36 md:h-36 rounded-full flex items-center justify-center transition-all duration-500 ${
                    status === ConnectionStatus.CONNECTED ? 'bg-gradient-to-br from-[#FE5733] to-[#981600] scale-110' : 
                    status === ConnectionStatus.ERROR ? 'bg-red-600' : 'bg-slate-700'
                  }`}>
                    {status === ConnectionStatus.CONNECTED ? (
                      <div className="flex gap-1 h-8 items-center">
                        {[1, 2, 3, 4].map(i => (
                          <div key={i} className="w-1.5 bg-white rounded-full animate-bounce" style={{ animationDuration: `${0.4 + i*0.1}s`, height: `${40 + i*15}%` }}></div>
                        ))}
                      </div>
                    ) : (
                      <i className={`fa-solid ${status === ConnectionStatus.CONNECTING ? 'fa-spinner fa-spin' : 'fa-microphone'} text-4xl text-white opacity-40`}></i>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-10 text-center z-10 max-w-sm">
                <h3 className={`text-2xl font-black mb-2 uppercase tracking-tight ${status === ConnectionStatus.ERROR ? 'text-red-500' : 'text-white'}`}>
                  {status === ConnectionStatus.CONNECTED ? 'SIGNAL ACTIVE' : 
                   status === ConnectionStatus.CONNECTING ? 'INITIALIZING...' :
                   status === ConnectionStatus.ERROR ? 'SYSTEM ERROR' : 'VOICE INTERFACE'}
                </h3>
                <p className="text-slate-500 font-bold text-xs uppercase tracking-widest leading-relaxed">
                  {status === ConnectionStatus.CONNECTED ? 'Speak freely with our technical consultant' : 
                   status === ConnectionStatus.ERROR ? (errorDetail || 'Hardware failure detected') :
                   'Experience Itero Circular Economy Consulting'}
                </p>
              </div>
            </div>

            {/* Transcription Bubble */}
            {(currentInputText || currentOutputText) && (
              <div className="px-8 pb-4">
                <div className="bg-slate-950/80 backdrop-blur-xl p-5 rounded-3xl border border-[#FE5733]/30 shadow-2xl animate-in fade-in slide-in-from-bottom-2">
                  <div className="text-sm font-medium leading-relaxed">
                    {currentInputText && <p className="text-slate-500 mb-2">"{currentInputText}"</p>}
                    {currentOutputText && <p className="text-white border-l-2 border-[#FE5733] pl-4">{currentOutputText}</p>}
                  </div>
                </div>
              </div>
            )}

            {/* Control Bar - THE BUTTONS */}
            <div className="p-8 md:p-10 bg-slate-900/90 border-t border-slate-800 flex items-center justify-center gap-6">
              <button 
                onClick={toggleMute}
                disabled={status !== ConnectionStatus.CONNECTED}
                className={`w-14 h-14 rounded-2xl flex items-center justify-center border-2 transition-all ${
                  isMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-[#FE5733]'
                } disabled:opacity-20`}
              >
                <i className={`fa-solid ${isMuted ? 'fa-microphone-slash' : 'fa-microphone'} text-xl`}></i>
              </button>

              <button 
                onClick={status === ConnectionStatus.CONNECTED ? stopSession : startSession}
                className={`flex-1 md:flex-none md:px-12 py-5 rounded-2xl font-black text-sm uppercase tracking-[0.2em] transition-all shadow-2xl flex items-center justify-center gap-3 ${
                  status === ConnectionStatus.CONNECTED 
                    ? 'bg-red-600 hover:bg-red-700 text-white' 
                    : 'bg-gradient-to-r from-[#FE5733] to-[#981600] text-white hover:scale-[1.02] active:scale-95'
                }`}
              >
                <i className={`fa-solid ${status === ConnectionStatus.CONNECTED ? 'fa-phone-slash' : 'fa-bolt-lightning'} text-lg`}></i>
                {status === ConnectionStatus.CONNECTED ? 'End Session' : 'Initialize Agent'}
              </button>

              <button 
                onClick={() => window.location.reload()}
                className="w-14 h-14 rounded-2xl flex items-center justify-center bg-slate-800 border-2 border-slate-700 text-slate-400 hover:border-[#FE5733] transition-all"
              >
                <i className="fa-solid fa-rotate-right text-xl"></i>
              </button>
            </div>
          </div>

          {/* Transcript Log */}
          <div className="bg-slate-900/40 rounded-[2.5rem] p-8 border border-slate-800 flex-1 min-h-[250px] shadow-xl">
            <h4 className="text-[10px] font-black text-slate-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-3">
              <span className="w-1.5 h-1.5 bg-[#FE5733] rounded-full"></span>
              Consultation Log
            </h4>
            <div className="space-y-4 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
              {transcriptionHistory.length === 0 ? (
                <div className="text-center py-12 opacity-20 flex flex-col items-center">
                  <i className="fa-solid fa-shield-halved text-4xl mb-4"></i>
                  <p className="text-[10px] font-black uppercase tracking-widest">Awaiting Secure Link...</p>
                </div>
              ) : (
                transcriptionHistory.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] p-4 rounded-2xl text-xs font-bold leading-relaxed shadow-lg ${
                      msg.role === 'user' ? 'bg-slate-800 text-slate-300 rounded-tr-none' : 'bg-slate-900 text-white border border-[#FE5733]/20 rounded-tl-none'
                    }`}>
                      {msg.text}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>

      <footer className="p-6 bg-slate-950 border-t border-slate-900">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4 text-[10px] font-bold text-slate-600 uppercase tracking-[0.2em]">
          <p>&copy; {new Date().getFullYear()} Itero Technologies Ltd</p>
          <div className="flex gap-6">
            <a href="#" className="hover:text-[#FE5733]">Privacy Policy</a>
            <a href="#" className="hover:text-[#FE5733]">Compliance</a>
          </div>
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 20px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #FE5733; }
      `}</style>
    </div>
  );
};

export default App;
