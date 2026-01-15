
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
  <header className="flex items-center justify-between p-6 bg-[#0f172a]/80 backdrop-blur-md border-b border-slate-800 sticky top-0 z-50">
    <div className="flex items-center gap-4">
      <IteroLogo className="w-12 h-12 mr-3 drop-shadow-[0_0_10px_rgba(254,87,51,0.3)]" />
      <div>
        <h1 className="text-2xl font-black text-white tracking-tighter leading-none">
          ITERO<span className="text-[#FE5733]">TECH</span>
        </h1>
        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] mt-1">Circular Economy Systems</p>
      </div>
    </div>
    <div className="hidden md:flex items-center gap-8">
      <nav className="flex gap-6 text-sm font-semibold text-slate-400">
        <a href="https://www.itero-tech.com/technology" target="_blank" rel="noreferrer" className="hover:text-[#FE5733] transition-colors">Technology</a>
        <a href="https://www.itero-tech.com/wlpp" target="_blank" rel="noreferrer" className="hover:text-[#FE5733] transition-colors">WLPP</a>
        <a href="https://www.itero-tech.com/contact" target="_blank" rel="noreferrer" className="hover:text-[#FE5733] transition-colors">Contact</a>
      </nav>
      <div className="h-6 w-[1px] bg-slate-800"></div>
      <span className="px-4 py-1.5 bg-[#FE5733]/10 text-[#FE5733] rounded-full text-xs font-bold border border-[#FE5733]/30 tracking-wider">LIVE AGENT</span>
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

  const stopSession = useCallback(() => {
    console.log("Terminating session...");
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
    sourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    setStatus(ConnectionStatus.DISCONNECTED);
    setCurrentInputText('');
    setCurrentOutputText('');
  }, []);

  const startSession = async () => {
    try {
      console.log("Starting session initialization...");
      setStatus(ConnectionStatus.CONNECTING);
      setErrorDetail(null);

      // 1. Browser Capability Check
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Browser lacks microphone support or is not in a secure (HTTPS) context.");
      }

      // 2. Request Microphone Access First
      console.log("Requesting microphone permission...");
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000
        } 
      });
      streamRef.current = stream;
      console.log("Microphone access granted.");

      // 3. Setup Audio Contexts
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioCtx({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioCtx({ sampleRate: 24000 });
      
      // Wake up audio contexts
      await inputAudioContextRef.current!.resume();
      await outputAudioContextRef.current!.resume();

      outputNodeRef.current = outputAudioContextRef.current!.createGain();
      outputNodeRef.current.connect(outputAudioContextRef.current!.destination);

      // 4. Initialize Gemini
      if (!process.env.API_KEY) {
        throw new Error("System API Key is missing. Please contact administrator.");
      }
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      console.log("Connecting to Gemini Live API...");

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
            console.log("Gemini connection established.");
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
              setCurrentInputText(text => { if (text) appendToHistory('user', text); return ''; });
              setCurrentOutputText(text => { if (text) appendToHistory('model', text); return ''; });
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Gemini Session Error:', e);
            setErrorDetail("The AI connection failed. This might be a network or key issue.");
            setStatus(ConnectionStatus.ERROR);
            stopSession();
          },
          onclose: () => {
            console.log("Gemini connection closed.");
            setStatus(ConnectionStatus.DISCONNECTED);
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Session Initialization Failed:', err);
      setStatus(ConnectionStatus.ERROR);
      
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorDetail("Microphone access was blocked. Please enable it in your browser settings.");
      } else if (err.name === 'NotFoundError') {
        setErrorDetail("No microphone detected. Please plug in a headset.");
      } else {
        setErrorDetail(err.message || "Unknown interface failure. Check console for details.");
      }
      stopSession();
    }
  };

  const toggleMute = () => setIsMuted(!isMuted);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100 font-sans selection:bg-[#FE5733]/30">
      <Header />

      <main className="flex-1 max-w-6xl w-full mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column */}
        <div className="space-y-6">
          <section className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 shadow-xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:scale-110 transition-transform duration-700">
              <IteroLogo className="w-16 h-16" />
            </div>
            <h2 className="text-xs font-black text-[#FE5733] uppercase tracking-[0.2em] mb-4">Plant Status: WLPP</h2>
            <div className="space-y-4">
              <div className="flex justify-between items-center text-sm font-bold">
                <span className="text-slate-400">West London Pilot Plant</span>
                <span className="text-emerald-400 flex items-center gap-2">
                  <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span> ONLINE
                </span>
              </div>
              <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-[#981600] to-[#FE5733] w-3/4 rounded-full"></div>
              </div>
              <p className="text-[13px] text-slate-400 leading-relaxed">
                Pyrolysis validation active. Monitoring mixed plastic streams for conversion efficiency.
              </p>
            </div>
          </section>

          <section className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 shadow-xl">
            <h2 className="text-xs font-black text-[#FE5733] uppercase tracking-[0.2em] mb-4">Waste Intake Spec</h2>
            <ul className="grid grid-cols-1 gap-2">
              {WASTE_TYPES.map((type, idx) => (
                <li key={idx} className="flex items-center gap-3 text-[13px] text-slate-300 font-medium p-3 rounded-xl bg-slate-800/40 border border-transparent hover:border-[#FE5733]/20 transition-all">
                  <i className="fa-solid fa-check-circle text-[#FE5733] text-[10px]"></i>
                  {type}
                </li>
              ))}
            </ul>
          </section>

          <section className="bg-[#981600]/5 rounded-2xl p-6 border border-[#981600]/20">
            <h2 className="text-xs font-black text-white uppercase tracking-[0.2em] mb-4">Direct Support</h2>
            <div className="p-4 bg-slate-950/50 rounded-xl border border-white/5 space-y-4">
              <div className="flex items-center gap-3 text-sm group cursor-pointer">
                <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center group-hover:bg-[#FE5733]/20 transition-colors">
                  <i className="fa-solid fa-envelope text-[#FE5733]"></i>
                </div>
                <span className="text-slate-300 font-medium group-hover:text-white transition-colors">info@itero-tech.com</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center">
                  <i className="fa-solid fa-location-dot text-[#FE5733]"></i>
                </div>
                <span className="text-slate-300 font-medium">West London, UK</span>
              </div>
            </div>
          </section>
        </div>

        {/* Center/Right Column */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          <div className="bg-slate-900/40 rounded-[2.5rem] flex-1 flex flex-col border border-slate-800 overflow-hidden relative min-h-[500px] shadow-2xl backdrop-blur-sm">
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#FE5733 1px, transparent 0)', backgroundSize: '40px 40px' }}></div>
            
            <div className="flex-1 flex flex-col items-center justify-center p-8 relative">
              <div className="relative">
                <div className={`w-64 h-64 rounded-full flex items-center justify-center transition-all duration-1000 ${
                  status === ConnectionStatus.CONNECTED ? 'bg-[#FE5733]/10' : 'bg-slate-800/50'
                }`}>
                  <div className={`w-40 h-40 rounded-full flex items-center justify-center transition-all duration-700 relative z-10 ${
                    status === ConnectionStatus.CONNECTED 
                      ? 'bg-gradient-to-br from-[#FE5733] to-[#981600] shadow-[0_0_80px_rgba(254,87,51,0.5)] scale-110' 
                      : status === ConnectionStatus.ERROR ? 'bg-red-900/40 shadow-[0_0_40px_rgba(239,68,68,0.2)]' : 'bg-slate-700'
                  }`}>
                    {status === ConnectionStatus.CONNECTED ? (
                      <div className="flex gap-1.5 h-12 items-center">
                        {[1, 2, 3, 4, 5].map(i => (
                          <div key={i} className="w-2 bg-white rounded-full animate-bounce" style={{ animationDuration: `${0.4 + (i * 0.1)}s`, height: `${40 + (i * 10)}%` }}></div>
                        ))}
                      </div>
                    ) : (
                      <i className={`fa-solid ${status === ConnectionStatus.CONNECTING ? 'fa-spinner fa-spin' : status === ConnectionStatus.ERROR ? 'fa-triangle-exclamation text-red-500' : 'fa-microphone'} text-5xl text-white opacity-40`}></i>
                    )}
                  </div>
                  {status === ConnectionStatus.CONNECTED && (
                    <div className="absolute w-80 h-80 border border-[#FE5733]/20 rounded-full animate-[spin_10s_linear_infinite]"></div>
                  )}
                </div>
              </div>

              <div className="mt-12 text-center z-10 max-w-md px-4">
                <h3 className={`text-3xl font-black mb-3 uppercase tracking-tight ${status === ConnectionStatus.ERROR ? 'text-red-500' : 'text-white'}`}>
                  {status === ConnectionStatus.CONNECTED ? 'SIGNAL ESTABLISHED' : 
                   status === ConnectionStatus.CONNECTING ? 'CALIBRATING...' :
                   status === ConnectionStatus.ERROR ? 'INTERFACE FAILED' : 'VOICE CONSULTING HUB'}
                </h3>
                <p className={`font-semibold leading-relaxed text-sm ${status === ConnectionStatus.ERROR ? 'text-red-400' : 'text-slate-400'}`}>
                  {status === ConnectionStatus.CONNECTED ? 'The AI Consultant is ready. Ask about Itero-Oil™ or modular scalability.' : 
                   status === ConnectionStatus.ERROR ? (errorDetail || 'Check browser permissions and refresh.') :
                   'Start a session to interface with our Technical Circular Economy Consultant.'}
                </p>
                {status === ConnectionStatus.ERROR && (
                   <button 
                     onClick={() => window.location.reload()}
                     className="mt-6 px-6 py-2 bg-red-500/10 border border-red-500/50 text-red-500 text-xs font-black uppercase tracking-widest rounded-full hover:bg-red-500 hover:text-white transition-all"
                   >
                     Reset Interface
                   </button>
                )}
              </div>

              {(currentInputText || currentOutputText) && (
                <div className="absolute bottom-8 left-8 right-8 bg-[#0f172a]/95 backdrop-blur-2xl p-6 rounded-[2rem] border border-[#FE5733]/30 shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-2 h-2 bg-[#FE5733] rounded-full animate-pulse"></span>
                    <span className="text-[10px] font-black text-[#FE5733] uppercase tracking-[0.2em]">Signal Processor</span>
                  </div>
                  <div className="text-[15px] font-medium leading-relaxed max-h-32 overflow-y-auto custom-scrollbar">
                    {currentInputText && <p className="text-slate-400 mb-2 italic">"{currentInputText}"</p>}
                    {currentOutputText && <p className="text-white border-l-2 border-[#FE5733] pl-4">{currentOutputText}</p>}
                  </div>
                </div>
              )}
            </div>

            <div className="p-10 bg-slate-900/80 border-t border-slate-800 flex items-center justify-center gap-6">
              <button 
                onClick={toggleMute}
                disabled={status !== ConnectionStatus.CONNECTED}
                className={`w-14 h-14 rounded-2xl flex items-center justify-center border-2 transition-all duration-300 ${
                  isMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-[#FE5733]'
                } disabled:opacity-20`}
                title={isMuted ? "Unmute" : "Mute"}
              >
                <i className={`fa-solid ${isMuted ? 'fa-microphone-slash' : 'fa-microphone'} text-xl`}></i>
              </button>

              <button 
                onClick={status === ConnectionStatus.CONNECTED ? stopSession : startSession}
                className={`px-12 py-5 rounded-2xl font-black text-sm uppercase tracking-widest transition-all duration-500 flex items-center gap-4 shadow-2xl ${
                  status === ConnectionStatus.CONNECTED 
                    ? 'bg-red-600 hover:bg-red-700 text-white shadow-red-900/20' 
                    : 'bg-gradient-to-r from-[#FE5733] to-[#981600] hover:shadow-[#FE5733]/30 text-white scale-100 hover:scale-105'
                }`}
              >
                <i className={`fa-solid ${status === ConnectionStatus.CONNECTED ? 'fa-phone-slash' : 'fa-bolt-lightning'} text-lg`}></i>
                {status === ConnectionStatus.CONNECTED ? 'Terminate' : 'Initialize Agent'}
              </button>

              <button className="w-14 h-14 rounded-2xl flex items-center justify-center bg-slate-800 border-2 border-slate-700 text-slate-300 hover:border-[#FE5733] transition-all">
                <i className="fa-solid fa-gear text-xl"></i>
              </button>
            </div>
          </div>

          <div className="bg-slate-900/50 rounded-[2.5rem] p-8 border border-slate-800 flex-1 min-h-[250px] flex flex-col shadow-xl">
            <h4 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] mb-6 flex items-center gap-3">
              <div className="w-1.5 h-1.5 bg-[#FE5733] rounded-full"></div>
              Session Transcript
            </h4>
            <div className="space-y-6 overflow-y-auto max-h-[400px] pr-4 custom-scrollbar">
              {transcriptionHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-700 opacity-30 gap-4">
                  <i className="fa-solid fa-lock text-4xl"></i>
                  <p className="text-xs font-black uppercase tracking-widest">End-to-End Encrypted Session</p>
                </div>
              ) : (
                transcriptionHistory.map((msg, i) => (
                  <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2`}>
                    <div className={`max-w-[90%] p-5 rounded-3xl text-[14px] font-medium leading-relaxed ${
                      msg.role === 'user' 
                        ? 'bg-slate-800 text-slate-200 rounded-tr-none' 
                        : 'bg-gradient-to-br from-[#FE5733]/10 to-[#981600]/10 text-white border border-[#FE5733]/20 rounded-tl-none shadow-lg shadow-[#FE5733]/5'
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

      <footer className="p-8 bg-slate-950 border-t border-slate-900 text-center">
        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.3em]">
          &copy; {new Date().getFullYear()} Itero Technologies Ltd &bull; Scaling the Circular Economy
        </p>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 20px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #FE5733; }
      `}</style>
    </div>
  );
};

export default App;
