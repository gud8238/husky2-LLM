import { useState, useEffect, useRef } from 'react';
import { 
  Wifi, 
  WifiOff, 
  Send, 
  Mic, 
  Cpu, 
  Camera, 
  Sparkles, 
  UserCheck, 
  Box, 
  Smile, 
  GitCommit, 
  Tv, 
  Layers, 
  Play,
  RotateCcw,
  Sliders,
  MessageSquare
} from 'lucide-react';
import { parseNaturalLanguageCommand } from './services/gemini';

// Declare Web Speech API globally for TS compiler
declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

interface Message {
  id: string;
  sender: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
}

interface DetectedObject {
  id: number;
  label: string;
  x: number; // Percentage 0-100
  y: number; // Percentage 0-100
  width: number; // Percentage
  height: number; // Percentage
  confidence: number;
}

const CV_MODES = [
  { id: 'face_recognition', name: '안면 인식', desc: '얼굴 식별 및 등록', icon: UserCheck, color: 'text-violet-400 bg-violet-950/20 border-violet-800/30' },
  { id: 'object_recognition', name: '객체 인식', desc: '주변 사물 실시간 탐지', icon: Box, color: 'text-indigo-400 bg-indigo-950/20 border-indigo-800/30' },
  { id: 'face_expression', name: '감정 인식', desc: '표정 기반 감정 분석', icon: Smile, color: 'text-fuchsia-400 bg-fuchsia-950/20 border-fuchsia-800/30' },
  { id: 'object_tracking', name: '객체 추적', desc: '지정 대상 실시간 추적', icon: Layers, color: 'text-emerald-400 bg-emerald-950/20 border-emerald-800/30' },
  { id: 'line_tracking', name: '라인 트래킹', desc: '바닥 주행 안내선 추적', icon: GitCommit, color: 'text-rose-400 bg-rose-950/20 border-rose-800/30' },
  { id: 'color_recognition', name: '컬러 인식', desc: '지정 색상 추출 및 판별', icon: Camera, color: 'text-amber-400 bg-amber-950/20 border-amber-800/30' },
  { id: 'tag_recognition', name: '태그 인식', desc: 'QR 및 마크 패턴 해독', icon: Tv, color: 'text-teal-400 bg-teal-950/20 border-teal-800/30' },
];

export default function App() {
  const [huskyIp, setHuskyIp] = useState<string>(() => localStorage.getItem('husky_ip') || '10.135.209.36');
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');
  const [activeMode, setActiveMode] = useState<string>('face_recognition');
  const [chatInput, setChatInput] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      sender: 'assistant',
      text: '안녕하세요! 허스키렌즈2 AI 비전 컨트롤 스테이션에 오신 것을 환영합니다. Wope 스타일의 미니멀 그리드 시스템으로 전면 개편되었습니다. 자연어로 명령하거나 아래 패널에서 직접 비전 모드를 제어해 보세요.',
      timestamp: new Date()
    }
  ]);
  const [detectedObjects, setDetectedObjects] = useState<DetectedObject[]>([
    { id: 1, label: 'Person', x: 25, y: 15, width: 35, height: 65, confidence: 94 },
    { id: 2, label: 'Object', x: 65, y: 40, width: 20, height: 35, confidence: 88 }
  ]);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<any | null>(null);

  // Sync IP to localStorage
  useEffect(() => {
    localStorage.setItem('husky_ip', huskyIp);
  }, [huskyIp]);

  // Scroll chat to bottom
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Initialize Speech Recognition (Web Speech API)
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.lang = 'ko-KR';
      rec.interimResults = false;

      rec.onstart = () => setIsListening(true);
      rec.onend = () => setIsListening(false);
      rec.onresult = async (event: any) => {
        const transcript = event.results[0][0].transcript;
        setChatInput(transcript);
        handleSendMessage(transcript);
      };

      recognitionRef.current = rec;
    }
  }, []);

  // Ping the HuskyLens 2 MCP bridge to verify connection status
  const checkConnection = async (targetIpAddress: string) => {
    setConnectionStatus('connecting');
    try {
      const response = await fetch(`http://localhost:9999/api/ping?ip=${targetIpAddress}`);
      const data = await response.json();
      if (data.online) {
        setConnectionStatus('connected');
        addSystemMessage(`🔌 허스키렌즈2(${targetIpAddress}) 및 MCP Bridge가 연동되었습니다.`);
      } else {
        setConnectionStatus('disconnected');
        addSystemMessage(`❌ 연결 실패: IP(${targetIpAddress}) 및 무선 네트워크 환경을 확인해 주세요.`);
      }
    } catch (err) {
      setConnectionStatus('disconnected');
      addSystemMessage('❌ 로컬 중계 서버(stream-broker)가 작동하지 않고 있습니다. 터미널을 확인하세요.');
    }
  };

  useEffect(() => {
    checkConnection(huskyIp);
  }, []);

  // Manual Mode Switch Function
  const selectModeManually = async (modeId: string) => {
    if (connectionStatus !== 'connected') {
      addSystemMessage('⚠️ 허스키렌즈2의 연결을 먼저 확인해 주세요.');
      return;
    }
    setActiveMode(modeId);
    try {
      const response = await fetch('http://localhost:9999/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetIp: huskyIp,
          mode: modeId,
          commandType: 'changeMode'
        })
      });
      const data = await response.json();
      if (data.success) {
        addSystemMessage(`⚙️ 수동 설정: 비전 알고리즘이 "${CV_MODES.find(m => m.id === modeId)?.name}"으로 전환되었습니다.`);
        generateMockDetections(modeId);
      } else {
        addSystemMessage(`❌ 모드 전환 실패: ${data.error}`);
      }
    } catch (e: any) {
      addSystemMessage(`❌ 통신 실패: ${e.message}`);
    }
  };

  // Initialize WebRTC Stream Player using go2rtc signaling
  const startStreaming = async () => {
    if (connectionStatus !== 'connected') {
      addSystemMessage('⚠️ 허스키렌즈2와 먼저 연결을 완료해야 합니다.');
      return;
    }

    setIsStreaming(true);
    try {
      addSystemMessage('📹 미디어 중계 서버에 영상 스트림을 매핑하고 있습니다...');
      
      const mapRes = await fetch(`http://localhost:9999/api/stream/start?ip=${huskyIp}`);
      if (!mapRes.ok) {
        throw new Error('RTSP stream mapping request failed');
      }

      addSystemMessage('📹 WebRTC 보안 터널 및 SDP 협상 조율 중...');

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      peerConnectionRef.current = pc;

      pc.ontrack = (event) => {
        console.log('📹 go2rtc WebRTC Stream Active:', event.streams);
        if (videoRef.current) {
          videoRef.current.srcObject = event.streams[0];
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          stopStreaming();
        }
      };

      pc.addTransceiver('video', { direction: 'recvonly' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const signalingRes = await fetch(`http://localhost:9999/api/stream/webrtc`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: offer.sdp
      });

      if (!signalingRes.ok) {
        let errDetails = '';
        try {
          const errData = await signalingRes.json();
          errDetails = errData.error || '';
        } catch (e) {
          try {
            errDetails = await signalingRes.text();
          } catch(e2) {}
        }
        
        if (
          errDetails.toLowerCase().includes('refused') || 
          errDetails.includes('8554') || 
          errDetails.toLowerCase().includes('connectex')
        ) {
          throw new Error('무선 영상 포트(8554) 연결이 차단되었습니다. 허스키렌즈2 기기 메뉴의 [Video Streaming]에서 RTSP 기능이 ON 상태인지 확인하세요.');
        }
        throw new Error(errDetails || `SDP answer negotiation failed (${signalingRes.status})`);
      }

      const answerSdp = await signalingRes.text();
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: answerSdp
      }));

      addSystemMessage('📹 초저지연 무선 비디오 스트리밍이 연동되었습니다.');

    } catch (err: any) {
      console.error(err);
      addSystemMessage(`❌ 스트리밍 오류: ${err.message}`);
      setIsStreaming(false);
    }
  };

  const stopStreaming = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsStreaming(false);
    addSystemMessage('⏹️ WebRTC 비디오 스트리밍 송출을 중단했습니다.');
  };

  const addSystemMessage = (text: string) => {
    setMessages(prev => [...prev, {
      id: Math.random().toString(),
      sender: 'system',
      text,
      timestamp: new Date()
    }]);
  };

  // Toggle Voice listening (STT)
  const toggleListening = () => {
    if (!recognitionRef.current) {
      addSystemMessage('⚠️ 음성 인식을 지원하지 않는 환경입니다. Chrome 브라우저를 권장합니다.');
      return;
    }

    if (isListening) {
      recognitionRef.current.stop();
    } else {
      recognitionRef.current.start();
    }
  };

  // Process user message (either through voice or button submit)
  const handleSendMessage = async (customText?: string) => {
    const textToSend = customText || chatInput;
    if (!textToSend.trim()) return;

    const userMsg: Message = {
      id: Math.random().toString(),
      sender: 'user',
      text: textToSend,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, userMsg]);
    if (!customText) setChatInput('');

    let visionContext = "";
    try {
      const recResponse = await fetch('http://localhost:9999/api/recognition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetIp: huskyIp })
      });
      const recResult = await recResponse.json();
      
      if (recResult.success && recResult.data) {
        const blocks = recResult.data.blocks || [];
        
        if (blocks.length > 0) {
          const descriptions = blocks.map((b: any) => `${b.label} (위치: x=${b.x}, y=${b.y}, 폭=${b.width}, 높이=${b.height})`);
          visionContext = `감지된 객체 ${blocks.length}개: ${descriptions.join(', ')}`;
          
          const camWidth = 1920;
          const camHeight = 1080;
          const mapped = blocks.map((b: any, idx: number) => {
            const wPercent = (b.width / camWidth) * 100;
            const hPercent = (b.height / camHeight) * 100;
            const xPercent = (b.x / camWidth) * 100 - wPercent / 2;
            const yPercent = (b.y / camHeight) * 100 - hPercent / 2;
            
            return {
              id: b.id !== undefined ? b.id : idx,
              label: b.label || 'Object',
              x: Math.max(0, Math.min(100, xPercent)),
              y: Math.max(0, Math.min(100, yPercent)),
              width: Math.max(2, Math.min(100, wPercent)),
              height: Math.max(2, Math.min(100, hPercent)),
              confidence: b.confidence || 0
            };
          });
          setDetectedObjects(mapped);
        } else {
          setDetectedObjects([]);
          visionContext = "현재 카메라 뷰에 감지된 물체나 얼굴이 없습니다.";
        }
      } else {
        setDetectedObjects([]);
        visionContext = recResult.error 
          ? `카메라 데이터 조회 실패: ${recResult.error}` 
          : "현재 카메라 뷰에 감지된 물체나 얼굴이 없습니다.";
      }
    } catch (e) {
      console.error(e);
      visionContext = "카메라 인식 서버와 연결이 불안정합니다.";
    }

    try {
      const parsedCmd = await parseNaturalLanguageCommand(textToSend, visionContext);
      
      const assistantMsg: Message = {
        id: Math.random().toString(),
        sender: 'assistant',
        text: parsedCmd.assistantResponse,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, assistantMsg]);

      if (parsedCmd.functionName === 'changeHuskyLensMode') {
        const mode = parsedCmd.args.mode;
        const parameter = parsedCmd.args.parameter;
        
        const response = await fetch('http://localhost:9999/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetIp: huskyIp,
            mode,
            parameter,
            commandType: 'changeMode'
          })
        });
        
        const data = await response.json();
        if (data.success) {
          setActiveMode(mode);
          addSystemMessage(`⚙️ MCP 명령: 허스키렌즈2가 "${CV_MODES.find(m => m.id === mode)?.name}" 모드로 전환되었습니다.`);
          generateMockDetections(mode, parameter);
        } else {
          addSystemMessage(`❌ MCP 설정 명령 전달 실패: ${data.error}`);
        }
      } else if (parsedCmd.functionName === 'learnNewTarget') {
        const target = parsedCmd.args.targetName;
        
        const response = await fetch('http://localhost:9999/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetIp: huskyIp,
            parameter: target,
            commandType: 'learn'
          })
        });

        const data = await response.json();
        if (data.success) {
          addSystemMessage(`🎓 MCP 학습: 새 타겟 "${target}" 학습을 진행했습니다.`);
        } else {
          addSystemMessage(`❌ MCP 학습 명령 실패: ${data.error}`);
        }
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: Math.random().toString(),
        sender: 'assistant',
        text: `명령 분석 처리 실패: ${err.message}`,
        timestamp: new Date()
      }]);
    }
  };

  const generateMockDetections = (mode: string, param?: string) => {
    const label = param || (mode === 'face_recognition' ? 'User' : 'Object');
    if (mode === 'face_recognition') {
      setDetectedObjects([
        { id: 101, label: label, x: 38, y: 22, width: 24, height: 42, confidence: 98 }
      ]);
    } else if (mode === 'object_tracking') {
      setDetectedObjects([
        { id: 102, label: `Tracking: ${label}`, x: 45, y: 35, width: 18, height: 18, confidence: 99 }
      ]);
    } else if (mode === 'face_expression') {
      setDetectedObjects([
        { id: 103, label: 'Happy (Owner)', x: 35, y: 20, width: 30, height: 50, confidence: 92 }
      ]);
    } else if (mode === 'color_recognition') {
      setDetectedObjects([
        { id: 104, label: `Color: ${label}`, x: 20, y: 60, width: 15, height: 15, confidence: 96 }
      ]);
    } else {
      setDetectedObjects([]);
    }
  };

  return (
    <div className="min-h-screen lg:h-screen lg:min-h-0 p-4 md:p-6 flex flex-col max-w-7xl mx-auto overflow-hidden fade-in-wope">
      {/* Upper Navigation Bento Card */}
      <header className="bento-card p-4 flex flex-col md:flex-row items-center justify-between gap-4 mb-5 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-wope-purple/10 border border-wope-purple/20 shadow-[0_0_20px_rgba(139,92,246,0.15)]">
            <Sparkles className="w-5 h-5 text-wope-violet" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-brand-slate-100 to-wope-violet">
              HuskyVision AI Link
            </h1>
            <p className="text-[9px] text-brand-slate-400 font-bold uppercase tracking-widest mt-0.5 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-wope-purple animate-pulse"></span>
              HuskyLens 2 Smart Control Station <span className="text-wope-violet/85">(Wope Premium Style)</span>
            </p>
          </div>
        </div>

        {/* Hardware IP & Connection controls */}
        <div className="flex items-center gap-2.5 bg-white/[0.02] p-1.5 px-2.5 rounded-xl border border-white/[0.04] shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
          <div className="flex items-center gap-2 px-1">
            <input 
              type="text" 
              value={huskyIp}
              onChange={(e) => setHuskyIp(e.target.value)}
              placeholder="Husky IP Address"
              className="bg-transparent text-xs font-semibold outline-none text-wope-violet placeholder-brand-slate-600 w-32 shadow-none border-none"
            />
          </div>
          <button 
            onClick={() => checkConnection(huskyIp)}
            className="btn-wope-secondary flex items-center gap-1.5 py-1 px-3 rounded-lg text-[10px] font-bold cursor-pointer"
          >
            {connectionStatus === 'connecting' ? (
              <span className="w-2.5 h-2.5 border-2 border-wope-purple border-t-transparent rounded-full animate-spin"></span>
            ) : connectionStatus === 'connected' ? (
              <Wifi className="w-3 h-3 text-wope-purple animate-pulse-slow" />
            ) : (
              <WifiOff className="w-3 h-3 text-brand-slate-500" />
            )}
            {connectionStatus === 'connecting' ? '연결중' : connectionStatus === 'connected' ? '연결됨' : '연결 확인'}
          </button>
        </div>
      </header>

      {/* Main 12-Column Grid Layout */}
      <main className="grid grid-cols-1 lg:grid-cols-12 gap-5 flex-1 lg:min-h-0 overflow-y-auto lg:overflow-hidden mb-2">
        
        {/* Left Bento Area (8 Columns) - Video stream and manual controllers */}
        <div className="lg:col-span-8 flex flex-col gap-5 lg:h-full lg:min-h-0">
          
          {/* Bento: WebRTC Live Streaming Player */}
          <div className="bento-card flex-1 flex flex-col overflow-hidden relative group lg:min-h-0 h-full">
            
            {/* Live Video Header */}
            <div className="p-3.5 flex items-center justify-between border-b border-white/[0.04] bg-white/[0.01]">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isStreaming ? 'indicator-active-wope' : connectionStatus === 'connected' ? 'indicator-online-wope' : 'indicator-offline-wope'}`} />
                <span className="text-[10px] font-bold text-brand-slate-300 tracking-wide uppercase flex items-center gap-1">
                  {isStreaming ? (
                    <>
                      <span className="text-emerald-400">LIVE</span>
                      <span className="text-brand-slate-500">| WebRTC 초저지연 송출 중</span>
                    </>
                  ) : '스트리밍 대기 상태'}
                </span>
              </div>
              
              <div className="flex gap-2">
                {!isStreaming ? (
                  <button 
                    onClick={startStreaming}
                    className="btn-wope-primary flex items-center gap-1.5 py-1 px-3 rounded-lg text-[10px] font-semibold cursor-pointer"
                  >
                    <Play className="w-3 h-3" /> 스트리밍 활성화
                  </button>
                ) : (
                  <button 
                    onClick={stopStreaming}
                    className="btn-wope-danger flex items-center gap-1.5 py-1 px-3 rounded-lg text-[10px] font-semibold cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" /> 스트리밍 중단
                  </button>
                )}
              </div>
            </div>

            {/* Video Canvas Body */}
            <div className="flex-1 min-h-[340px] bg-[#020306] flex items-center justify-center relative overflow-hidden h-full">
              <video 
                ref={videoRef}
                autoPlay
                playsInline
                className={`w-full h-full object-cover transition-all duration-700 ${isStreaming ? 'opacity-100 scale-100' : 'opacity-[0.03] scale-95'}`}
              />

              {/* Streaming idle container */}
              {!isStreaming && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
                  <div className="p-4 rounded-2xl bg-white/[0.01] border border-white/[0.04] shadow-[0_0_30px_rgba(139,92,246,0.02)] mb-4">
                    <Cpu className="w-10 h-10 text-wope-purple/30 animate-pulse-slow" />
                  </div>
                  <h3 className="text-sm font-semibold text-brand-slate-200">RTSP & WebRTC 스트리밍 수신 대기</h3>
                  <p className="text-xs text-brand-slate-500 max-w-[300px] mt-2 leading-relaxed">
                    허스키렌즈2의 고해상도 RTSP 영상을 <span className="text-wope-violet font-semibold">초저지연 WebRTC</span> 기술을 사용해 무선 수신합니다.
                  </p>
                </div>
              )}

              {/* Bounding Box Drawing Layer with minimal Violet Wope styling */}
              {isStreaming && (
                <div className="absolute inset-0 pointer-events-none z-20">
                  {detectedObjects.map((obj) => (
                    <div 
                      key={obj.id}
                      className="absolute border border-wope-purple bg-wope-purple/[0.02] shadow-[0_0_12px_rgba(139,92,246,0.3)] transition-all duration-300"
                      style={{
                        left: `${obj.x}%`,
                        top: `${obj.y}%`,
                        width: `${obj.width}%`,
                        height: `${obj.height}%`,
                      }}
                    >
                      {/* Minimalist corner indicators */}
                      <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-wope-violet pointer-events-none -mt-[1px] -ml-[1px]" />
                      <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-wope-violet pointer-events-none -mt-[1px] -mr-[1px]" />
                      <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-wope-violet pointer-events-none -mb-[1px] -ml-[1px]" />
                      <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-wope-violet pointer-events-none -mb-[1px] -mr-[1px]" />

                      {/* Top labeling tag */}
                      <span className="absolute -top-6 left-0 bg-[#0a0b12] text-wope-violet text-[9px] font-semibold px-2 py-0.5 rounded border border-white/[0.06] shadow-md uppercase tracking-wider flex items-center gap-1">
                        <Sparkles className="w-2.5 h-2.5" />
                        {obj.label} ({obj.confidence}%)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Bento: Interactive CV Mode Selector Grid */}
          <div className="bento-card p-4 flex-shrink-0">
            <div className="flex items-center gap-2 mb-3">
              <Sliders className="w-3.5 h-3.5 text-wope-violet" />
              <h3 className="text-xs font-semibold tracking-wider text-brand-slate-200">하드웨어 비전 알고리즘 수동 설정</h3>
            </div>
            
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2.5">
              {CV_MODES.map((mode) => {
                const IconComponent = mode.icon;
                const isSelected = activeMode === mode.id;
                
                return (
                  <button
                    key={mode.id}
                    onClick={() => selectModeManually(mode.id)}
                    className={`vision-mode-pill text-left transition-all relative ${
                      isSelected ? 'active' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className={`p-1.5 rounded-lg border border-white/[0.04] bg-white/[0.01] ${isSelected ? 'text-wope-violet' : 'text-brand-slate-400'}`}>
                        <IconComponent className="w-3.5 h-3.5" />
                      </div>
                      {isSelected && (
                        <span className="w-1.5 h-1.5 rounded-full bg-wope-purple shadow-[0_0_8px_#8b5cf6]" />
                      )}
                    </div>
                    <span className="text-[10px] font-bold text-white block truncate">{mode.name}</span>
                    <span className="text-[8px] text-brand-slate-500 block truncate leading-tight mt-0.5">{mode.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Bento Area (4 Columns) - Gemini Assistant conversation & STT radar */}
        <div className="lg:col-span-4 flex flex-col lg:h-full lg:min-h-0">
          <div className="bento-card flex-1 flex flex-col overflow-hidden h-full">
            
            {/* AI Assistant Bento Header */}
            <div className="p-3.5 border-b border-white/[0.04] bg-white/[0.01] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-lg bg-wope-purple/10 text-wope-violet border border-wope-purple/20">
                  <MessageSquare className="w-3.5 h-3.5" />
                </div>
                <span className="text-[10px] font-semibold tracking-wider uppercase text-brand-slate-300">Gemini AI 비전 비서</span>
              </div>
              <span className="text-[8px] bg-[#07080f] border border-white/[0.06] text-wope-violet font-semibold px-2 py-0.5 rounded-full">
                Gemini 3.5 Flash
              </span>
            </div>

            {/* Conversation Log area */}
            <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-3.5 bg-gradient-to-b from-transparent to-[#040508]/20">
              {messages.map((msg) => {
                if (msg.sender === 'system') {
                  return (
                    <div key={msg.id} className="text-center my-1 fade-in-wope">
                      <span className="inline-block px-2.5 py-0.5 rounded-full text-[9px] font-semibold bg-white/[0.02] text-brand-slate-400 border border-white/[0.04] leading-normal shadow-[0_2px_4px_rgba(0,0,0,0.2)]">
                        {msg.text}
                      </span>
                    </div>
                  );
                }
                const isUser = msg.sender === 'user';
                return (
                  <div key={msg.id} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[90%] ${isUser ? 'self-end' : 'self-start'} fade-in-wope`}>
                    <div className={`p-3 rounded-xl text-xs leading-relaxed border ${
                      isUser 
                        ? 'bg-white/[0.03] border-white/[0.06] text-white rounded-tr-none' 
                        : 'bg-wope-purple/5 border-wope-purple/20 text-wope-violet rounded-tl-none'
                    }`}>
                      {msg.text}
                    </div>
                    <span className="text-[8px] text-brand-slate-500 mt-1 px-1 font-bold tracking-wide">
                      {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                );
              })}
              <div ref={chatBottomRef} />
            </div>

            {/* Voice Controller & Text Input Bar */}
            <div className="p-4 border-t border-white/[0.04] bg-white/[0.01]">
              <div className="flex items-center gap-2 bg-[#020306]/85 border border-white/[0.04] rounded-xl p-1.5 focus-within:border-wope-purple/40 focus-within:shadow-[0_0_15px_rgba(139,92,246,0.06)] transition-all">
                
                {/* Voice Mic Button with Elegant Wope pulsing lines */}
                <div className="relative">
                  {isListening && (
                    <div className="absolute inset-0 rounded-lg bg-wope-purple/10 animate-radar pointer-events-none" />
                  )}
                  <button 
                    onClick={toggleListening}
                    className={`p-2 rounded-lg transition-all duration-300 relative z-10 cursor-pointer ${
                      isListening 
                        ? 'bg-wope-purple/20 text-white border border-wope-purple/40 shadow-[0_0_12px_rgba(139,92,246,0.4)] scale-105' 
                        : 'bg-white/[0.01] text-brand-slate-400 hover:text-wope-violet border border-white/[0.04] hover:border-white/[0.1]'
                    }`}
                    title="자연어 음성 제어 송신"
                  >
                    {isListening ? (
                      <div className="flex items-center gap-0.5 justify-center w-4 h-4">
                        <span className="w-0.5 h-3 bg-white animate-soundwave [animation-delay:0.1s]"></span>
                        <span className="w-0.5 h-3 bg-white animate-soundwave [animation-delay:0.3s]"></span>
                        <span className="w-0.5 h-3 bg-white animate-soundwave [animation-delay:0.5s]"></span>
                      </div>
                    ) : (
                      <Mic className="w-4 h-4" />
                    )}
                  </button>
                </div>

                <input 
                  type="text" 
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                  placeholder={isListening ? "음성을 해석하고 있습니다..." : "대화를 하거나 명령해 보세요..."}
                  className="flex-1 bg-transparent text-xs text-brand-slate-200 outline-none placeholder-brand-slate-600 px-1 border-none"
                  disabled={isListening}
                />
                
                <button 
                  onClick={() => handleSendMessage()}
                  className="p-2 rounded-lg bg-gradient-to-r from-wope-purple to-wope-violet text-white hover:opacity-95 shadow-[0_2px_8px_rgba(139,92,246,0.3)] transition-all active:scale-95 flex items-center justify-center cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}
