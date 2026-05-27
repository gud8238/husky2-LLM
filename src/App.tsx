import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Wifi,
  WifiOff,
  Send,
  Mic,
  Cpu,
  Sparkles,
  Play,
  Square,
  MessageSquare,
  Eye,
  Zap,
  Settings,
  X,
  CheckCircle,
  AlertCircle,
  Info,
} from 'lucide-react';
import { parseNaturalLanguageCommand } from './services/gemini';
import {
  ContainerAnimated,
  ContainerInset,
  ContainerScroll,
  ContainerStagger,
} from '@/components/blocks/hero-video';

// ─── 타입 정의 ─────────────────────────────────────────────
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
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

// ─── localStorage 키 상수 ────────────────────────────────
const LS_MCP_URL  = 'husky_mcp_url';
const LS_RTSP_URL = 'husky_rtsp_url';
const LS_IP       = 'husky_ip';
const LS_BROKER_URL = 'husky_broker_url';
const LS_CONN_MODE = 'husky_conn_mode';
const LS_DIRECT_WEBRTC_URL = 'husky_direct_webrtc_url';

// 기본값 (사용자 최신 IP 10.161.176.236 기반 설정)
const DEFAULT_MCP_URL  = 'http://10.161.176.236:3000/sse';
const DEFAULT_RTSP_URL = 'rtsp://10.161.176.236:8554/live';
const DEFAULT_DIRECT_WEBRTC_URL = 'http://10.161.176.236:1984/api/webrtc?src=camera';

// ─── 메인 앱 ────────────────────────────────────────────────
export default function App() {
  // ── 연결 설정 상태 ──
  const [mcpUrl, setMcpUrl] = useState<string>(
    () => localStorage.getItem(LS_MCP_URL) || DEFAULT_MCP_URL
  );
  const [rtspUrl, setRtspUrl] = useState<string>(
    () => localStorage.getItem(LS_RTSP_URL) || DEFAULT_RTSP_URL
  );
  // 중계 서버 주소 상태 추가 (공백인 경우 로컬 구동 모드로 간주)
  const [brokerUrl, setBrokerUrl] = useState<string>(
    () => localStorage.getItem(LS_BROKER_URL) || ''
  );
  // 연결 모드: 'broker' = 중계 서버 경유(ngrok/로컬), 'direct' = 기기 직접 WebRTC
  const [connectionMode, setConnectionMode] = useState<'broker' | 'direct'>(
    () => (localStorage.getItem(LS_CONN_MODE) as 'broker' | 'direct') || 'broker'
  );
  // 기기 직접 WebRTC 시그널링 URL
  const [directWebrtcUrl, setDirectWebrtcUrl] = useState<string>(
    () => localStorage.getItem(LS_DIRECT_WEBRTC_URL) || DEFAULT_DIRECT_WEBRTC_URL
  );

  // ── 스트리밍 우회 타입 상태 ──
  // 'video' = RTCPeerConnection (기본), 'iframe' = go2rtc webrtc.html 임베딩, 'mjpeg' = go2rtc stream.mjpeg 이미지
  const [streamType, setStreamType] = useState<'video' | 'iframe' | 'mjpeg'>('video');

  // 설정 모달 내 임시 편집값
  const [draftMcpUrl, setDraftMcpUrl]   = useState<string>(mcpUrl);
  const [draftRtspUrl, setDraftRtspUrl] = useState<string>(rtspUrl);
  const [draftBrokerUrl, setDraftBrokerUrl] = useState<string>(brokerUrl);
  const [draftConnectionMode, setDraftConnectionMode] = useState<'broker' | 'direct'>(connectionMode);
  const [draftDirectWebrtcUrl, setDraftDirectWebrtcUrl] = useState<string>(directWebrtcUrl);

  // IP는 mcpUrl에서 자동 추출 (하위 호환)
  const huskyIp = (() => {
    try { return new URL(mcpUrl).hostname; } catch { return mcpUrl; }
  })();

  // ── CORS 우회 URL 가공 헬퍼 함수 ──
  const getIframeUrl = (signalingUrl: string) => {
    try {
      let target = signalingUrl.trim();
      if (!target.startsWith('http://') && !target.startsWith('https://')) {
        target = 'http://' + target;
      }
      const url = new URL(target);
      if (!url.port && !target.includes(':80') && !target.includes(':1984') && !target.includes(':3000')) {
        url.port = '1984';
      }
      if (url.pathname.includes('/api/webrtc')) {
        url.pathname = url.pathname.replace('/api/webrtc', '/webrtc.html');
      } else if (url.pathname === '/' || url.pathname === '') {
        url.pathname = '/webrtc.html';
      }
      if (!url.searchParams.get('src')) {
        url.searchParams.set('src', 'camera');
      }
      return url.toString();
    } catch {
      return `http://${huskyIp}:1984/webrtc.html?src=camera`;
    }
  };

  const getMjpegUrl = (signalingUrl: string) => {
    try {
      let target = signalingUrl.trim();
      if (!target.startsWith('http://') && !target.startsWith('https://')) {
        target = 'http://' + target;
      }
      const url = new URL(target);
      if (!url.port && !target.includes(':80') && !target.includes(':1984') && !target.includes(':3000')) {
        url.port = '1984';
      }
      if (url.pathname.includes('/api/webrtc')) {
        url.pathname = url.pathname.replace('/api/webrtc', '/api/stream.mjpeg');
      } else if (url.pathname === '/' || url.pathname === '') {
        url.pathname = '/api/stream.mjpeg';
      }
      if (!url.searchParams.get('src')) {
        url.searchParams.set('src', 'camera');
      }
      return url.toString();
    } catch {
      return `http://${huskyIp}:1984/api/stream.mjpeg?src=camera`;
    }
  };

  const [connectionStatus, setConnectionStatus] = useState<
    'connected' | 'disconnected' | 'connecting'
  >('disconnected');
  // MCP 세션 연결 오류 메시지 (모달 인라인 표시용)
  const [connectionError, setConnectionError] = useState<string>('');
  const [streamError, setStreamError]         = useState<string>('');
  const [chatInput, setChatInput]         = useState<string>('');
  const [messages, setMessages]           = useState<Message[]>([
    {
      id: 'welcome',
      sender: 'assistant',
      text: '안녕하세요! HuskyVision AI에 오신 것을 환영합니다. ⚙️ 설정 버튼으로 MCP 주소와 RTSP 주소를 입력하고 연결하세요.',
      timestamp: new Date(),
    },
  ]);
  const [detectedObjects, setDetectedObjects] = useState<DetectedObject[]>([]);
  const [isListening, setIsListening]         = useState<boolean>(false);
  const [isStreaming, setIsStreaming]           = useState<boolean>(false);
  const [showControlPanel, setShowControlPanel] = useState<boolean>(false);
  const [showSettings, setShowSettings]         = useState<boolean>(false);

  const videoRef          = useRef<HTMLVideoElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const chatBottomRef     = useRef<HTMLDivElement | null>(null);
  const recognitionRef    = useRef<any | null>(null);

  // ── localStorage 동기화 ──
  useEffect(() => {
    localStorage.setItem(LS_MCP_URL, mcpUrl);
    localStorage.setItem(LS_IP, huskyIp);
  }, [mcpUrl, huskyIp]);

  useEffect(() => {
    localStorage.setItem(LS_RTSP_URL, rtspUrl);
  }, [rtspUrl]);

  useEffect(() => {
    localStorage.setItem(LS_BROKER_URL, brokerUrl);
  }, [brokerUrl]);

  useEffect(() => {
    localStorage.setItem(LS_CONN_MODE, connectionMode);
  }, [connectionMode]);

  useEffect(() => {
    localStorage.setItem(LS_DIRECT_WEBRTC_URL, directWebrtcUrl);
  }, [directWebrtcUrl]);

  // ── 채팅 스크롤 ──
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── 음성인식 초기화 ──
  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.lang = 'ko-KR';
      rec.interimResults = false;
      rec.onstart = () => setIsListening(true);
      rec.onend   = () => setIsListening(false);
      rec.onresult = async (event: any) => {
        const transcript = event.results[0][0].transcript;
        setChatInput(transcript);
        handleSendMessage(transcript);
      };
      recognitionRef.current = rec;
    }
  }, []);

  // ─── 수동 연결 ─────────────────────────────────────────────
  // connectionMode에 따라 중계 서버를 경유하거나 기기에 직접 연결을 수행합니다.
  const manualConnect = async (
    targetMcpUrl?: string,
    targetBrokerUrl?: string,
    targetMode?: 'broker' | 'direct'
  ) => {
    const activeMcpUrl = targetMcpUrl !== undefined ? targetMcpUrl : mcpUrl;
    const activeBroker = targetBrokerUrl !== undefined ? targetBrokerUrl : brokerUrl;
    const activeMode = targetMode !== undefined ? targetMode : connectionMode;

    setConnectionStatus('connecting');
    setConnectionError('');

    if (activeMode === 'direct') {
      // 🌟 [기기 직접 연결 모드 (Direct WebRTC Mode)]
      addSystemMessage(`📡 기기 직접 연결 시도... (연결 주소: ${activeMcpUrl})`);
      try {
        let testUrl = activeMcpUrl;
        try {
          const parsed = new URL(activeMcpUrl);
          testUrl = `${parsed.protocol}//${parsed.host}`;
        } catch {}

        await fetch(testUrl, { method: 'HEAD', mode: 'no-cors' });
        
        addSystemMessage(`🔌 기기 직접 연결 확인 완료! (Wi-Fi 다이렉트 모드 활성화)`);
        setConnectionStatus('connected');
        setConnectionError('');
      } catch (err: any) {
        setConnectionStatus('disconnected');
        setConnectionError('기기에 직접 접근할 수 없습니다. Wi-Fi 및 브라우저 보안 설정을 확인해 주세요.');
        addSystemMessage(`❌ 기기 다이렉트 연결 실패: 동일한 Wi-Fi에 연결되어 있는지 확인해 주세요. (기기 IP: ${huskyIp})`);
        addSystemMessage(`💡 [보안 안내] HTTPS 배포 앱(Netlify)에서 HTTP 로컬 기기에 직접 통신하려면 브라우저 주소창 왼쪽 자물쇠/설정 아이콘을 클릭하여 '안전하지 않은 콘텐츠 허용' (Mixed Content 허용)을 활성화해 주셔야 합니다.`);
      }
    } else {
      // 🌟 [로컬 중계 서버 경유 모드 (Broker Proxy Mode)]
      const brokerBase = activeBroker.trim().replace(/\/$/, '');
      try {
        const pingRes = await fetch(
          `${brokerBase}/api/ping?mcpUrl=${encodeURIComponent(activeMcpUrl)}`
        );
        const pingData = await pingRes.json();

        if (!pingData.reachable) {
          setConnectionStatus('disconnected');
          const errMsg = pingData.error || '기기에 도달할 수 없습니다. IP와 Wi-Fi를 확인하세요.';
          setConnectionError(errMsg);
          addSystemMessage(`❌ 연결 실패: ${errMsg}`);
          return;
        }

        addSystemMessage(`📡 기기 도달 확인 완료. MCP 핸드셰이크 시작...`);

        const connectRes = await fetch(
          `${brokerBase}/api/connect?mcpUrl=${encodeURIComponent(activeMcpUrl)}`
        );
        const connectData = await connectRes.json();

        if (connectData.online) {
          setConnectionStatus('connected');
          setConnectionError('');
          addSystemMessage(`🔌 MCP 연결 성공 (${activeMcpUrl})`);
        } else {
          setConnectionStatus('disconnected');
          const errMsg = connectData.error || 'MCP 핸드셰이크 실패';
          setConnectionError(errMsg);
          addSystemMessage(`❌ MCP 연결 실패: ${errMsg}`);
        }
      } catch {
        setConnectionStatus('disconnected');
        setConnectionError('중계 서버(stream-broker)에 접속할 수 없습니다.');
        addSystemMessage(`❌ 중계 서버(${brokerBase || 'localhost'})가 실행 중이지 않거나 주소가 올바르지 않습니다. PC의 터미널에서 "node scripts/stream-broker.js"를 실행 중인지, 혹은 ngrok 등의 HTTPS 터널 주소가 입력되었는지 확인해 주세요.`);
      }
    }
  };

  // ─── 연결 해제 ─────────────────────────────────────────────
  const manualDisconnect = async () => {
    if (connectionMode === 'broker') {
      const brokerBase = brokerUrl.trim().replace(/\/$/, '');
      try {
        await fetch(`${brokerBase}/api/disconnect?mcpUrl=${encodeURIComponent(mcpUrl)}`);
      } catch { /* 무시 */ }
    }
    setConnectionStatus('disconnected');
    setConnectionError('');
    if (isStreaming) stopStreaming();
    addSystemMessage('🔌 연결을 해제했습니다.');
  };

  // ─── 설정 저장 ────────────────────────────────────────────
  const applySettings = () => {
    const trimmedMcp = draftMcpUrl.trim();
    const trimmedRtsp = draftRtspUrl.trim();
    const trimmedBroker = draftBrokerUrl.trim();
    const trimmedDirectUrl = draftDirectWebrtcUrl.trim();

    setMcpUrl(trimmedMcp);
    setRtspUrl(trimmedRtsp);
    setBrokerUrl(trimmedBroker);
    setConnectionMode(draftConnectionMode);
    setDirectWebrtcUrl(trimmedDirectUrl);
    setShowSettings(false);

    // 새 주소로 수동 연결 시도
    manualConnect(trimmedMcp, trimmedBroker, draftConnectionMode);
  };

  // ─── 스트리밍 시작 ────────────────────────────────────────
  const startStreaming = async () => {
    if (connectionStatus !== 'connected') {
      addSystemMessage('⚠️ 먼저 허스키렌즈2와 연결하세요.');
      return;
    }
    setIsStreaming(true);
    setStreamType('video'); // 기본값인 순정 WebRTC 비디오로 먼저 시도
    setStreamError('');

    if (connectionMode === 'direct') {
      // 🌟 [기기 직접 WebRTC 스트리밍 모드]
      // 포트 및 스트림명 자동 Fallback 스캔 목록 구성
      const candidateUrls = [
        directWebrtcUrl.trim(),
        `http://${huskyIp}:1984/api/webrtc?src=camera`,
        `http://${huskyIp}/api/webrtc?src=camera`,
        `http://${huskyIp}:1984/api/webrtc?src=live`,
        `http://${huskyIp}/api/webrtc?src=live`,
        `http://${huskyIp}:1984/api/webrtc?src=huskylens`,
        `http://${huskyIp}/api/webrtc?src=huskylens`
      ];

      // 중복 제거
      const scanUrls = Array.from(new Set(candidateUrls));

      let lastError: any = null;
      let success = false;

      for (let i = 0; i < scanUrls.length; i++) {
        const targetUrl = scanUrls[i];
        addSystemMessage(`📹 기기 직접 WebRTC 연결 시도 중 (${i+1}/${scanUrls.length}): ${targetUrl}`);
        
        try {
          const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
          });
          peerConnectionRef.current = pc;

          pc.ontrack = (event) => {
            if (videoRef.current) videoRef.current.srcObject = event.streams[0];
          };
          pc.oniceconnectionstatechange = () => {
            if (
              pc.iceConnectionState === 'failed' ||
              pc.iceConnectionState === 'disconnected'
            )
              stopStreaming();
          };
          pc.addTransceiver('video', { direction: 'recvonly' });

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          // 시그널링 API 호출
          const signalingRes = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: offer.sdp,
          });

          if (!signalingRes.ok) {
            throw new Error(`기기 응답 상태코드 오류 (${signalingRes.status})`);
          }

          const answerSdp = await signalingRes.text();
          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: 'answer', sdp: answerSdp })
          );
          
          addSystemMessage(`📹 기기 직접 WebRTC 스트리밍 연결이 성공적으로 수립되었습니다! (${targetUrl})`);
          success = true;
          setStreamError('');
          break; // 성공 시 스캔 중단
        } catch (err: any) {
          console.error(`Scan URL ${targetUrl} failed:`, err);
          lastError = err;
          // 실패 시 PeerConnection 정리 후 다음 후보 시도
          if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
            peerConnectionRef.current = null;
          }
        }
      }

      if (!success) {
        setIsStreaming(false);
        const errMsg = lastError?.message || '네트워크 오류';
        
        // TypeError: Failed to fetch는 대개 브라우저의 Mixed Content 차단에 기인함
        if (lastError instanceof TypeError || errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError')) {
          const blockMsg = '브라우저 혼합 콘텐츠(Mixed Content) 차단 감지됨';
          setStreamError(blockMsg);
          addSystemMessage(`❌ 기기 직접 스트리밍 실패: ${blockMsg}`);
          addSystemMessage(`💡 [Mixed Content 차단 해제 안내] HTTPS 배포 앱(Netlify)에서 HTTP 로컬 기기에 직접 통신하려면 브라우저 주소창 왼쪽 자물쇠 버튼을 클릭하여 '안전하지 않은 콘텐츠 허용'을 필히 활성화해야 합니다.`);
        } else {
          setStreamError(`연결 실패: ${errMsg}`);
          addSystemMessage(`❌ 기기 직접 스트리밍 실패: ${errMsg}`);
          addSystemMessage(`💡 동일한 Wi-Fi 환경에 연결되어 있는지, 기기 화면에 WebRTC가 정상적으로 켜져 있는지 확인해 주세요.`);
        }
      }
    } else {
      // 🌟 [로컬 중계 서버 경유 RTSP -> WebRTC 스트리밍 모드]
      const brokerBase = brokerUrl.trim().replace(/\/$/, '');
      try {
        addSystemMessage(`📹 RTSP 스트림 매핑 중: ${rtspUrl}`);
        // rtsp 파라미터로 커스텀 RTSP URL 전달
        const mapRes = await fetch(
          `${brokerBase}/api/stream/start?ip=${encodeURIComponent(huskyIp)}&rtsp=${encodeURIComponent(rtspUrl)}`
        );
        if (!mapRes.ok) throw new Error('RTSP 스트림 매핑 실패');

        addSystemMessage('📹 WebRTC SDP 협상 중...');
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        peerConnectionRef.current = pc;

        pc.ontrack = (event) => {
          if (videoRef.current) videoRef.current.srcObject = event.streams[0];
        };
        pc.oniceconnectionstatechange = () => {
          if (
            pc.iceConnectionState === 'failed' ||
            pc.iceConnectionState === 'disconnected'
          )
            stopStreaming();
        };
        pc.addTransceiver('video', { direction: 'recvonly' });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const signalingRes = await fetch(
          `${brokerBase}/api/stream/webrtc`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: offer.sdp,
          }
        );

        if (!signalingRes.ok) {
          let errDetails = '';
          try {
            const errData = await signalingRes.json();
            errDetails = errData.error || '';
          } catch {
            try { errDetails = await signalingRes.text(); } catch { /* empty */ }
          }
          if (errDetails.toLowerCase().includes('refused') || errDetails.includes('8554')) {
            throw new Error(
              '허스키렌즈2 기기에서 [Video Streaming] → RTSP Streaming을 ON으로 켜주세요.'
            );
          }
          throw new Error(errDetails || `SDP 협상 실패 (${signalingRes.status})`);
        }

        const answerSdp = await signalingRes.text();
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: 'answer', sdp: answerSdp })
        );
        addSystemMessage('📹 무선 WebRTC 스트리밍이 연동되었습니다!');
        setStreamError('');
      } catch (err: any) {
        setStreamError(`중계 스트리밍 오류: ${err.message}`);
        addSystemMessage(`❌ 스트리밍 오류: ${err.message}`);
        setIsStreaming(false);
      }
    }
  };

  const stopStreaming = () => {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsStreaming(false);
    setStreamType('video'); // 기본 비디오 모드로 초기화
    setDetectedObjects([]);
    addSystemMessage('⏹️ 스트리밍 종료');
  };

  const addSystemMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: Math.random().toString(), sender: 'system', text, timestamp: new Date() },
    ]);
  };

  const toggleListening = () => {
    if (!recognitionRef.current) {
      addSystemMessage('⚠️ Chrome 브라우저에서 음성인식을 지원합니다.');
      return;
    }
    if (isListening) recognitionRef.current.stop();
    else recognitionRef.current.start();
  };

  const handleSendMessage = async (customText?: string) => {
    const textToSend = customText || chatInput;
    if (!textToSend.trim()) return;

    const userMsg: Message = {
      id: Math.random().toString(),
      sender: 'user',
      text: textToSend,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    if (!customText) setChatInput('');

    const brokerBase = brokerUrl.trim().replace(/\/$/, '');

    // 실시간 인식 결과
    let visionContext = '';
    try {
      const recResponse = await fetch(`${brokerBase}/api/recognition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetIp: huskyIp, mcpUrl }),
      });
      const recResult = await recResponse.json();

      if (recResult.success && recResult.data) {
        const blocks = recResult.data.blocks || [];
        if (blocks.length > 0) {
          const descriptions = blocks.map(
            (b: any) =>
              `${b.label} (위치: 중앙x=${b.x}, 중앙y=${b.y}, 폭=${b.width}, 높이=${b.height})`
          );
          visionContext = `감지된 객체 ${blocks.length}개: ${descriptions.join(', ')}`;

          const camWidth  = 1920;
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
              confidence: b.confidence || 0,
            };
          });
          setDetectedObjects(mapped);
        } else {
          setDetectedObjects([]);
          visionContext = '현재 카메라 뷰에 감지된 물체가 없습니다.';
        }
      } else {
        setDetectedObjects([]);
        visionContext = '카메라 데이터를 가져올 수 없습니다.';
      }
    } catch {
      visionContext = '카메라 인식 서버에 연결할 수 없습니다.';
    }

    // Gemini 호출
    try {
      const result = await parseNaturalLanguageCommand(textToSend, visionContext);
      const assistantText = result.assistantResponse || '명령을 처리했습니다.';

      if (result.functionName === 'changeHuskyLensMode' && result.args?.mode) {
        const response = await fetch(`${brokerBase}/api/control`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetIp: huskyIp,
            mcpUrl,
            mode: result.args.mode,
            commandType: 'changeMode',
          }),
        });
        const data = await response.json();
        if (data.success) addSystemMessage('⚙️ 모드 전환 완료');
      }

      setMessages((prev) => [
        ...prev,
        { id: Math.random().toString(), sender: 'assistant', text: assistantText, timestamp: new Date() },
      ]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { id: Math.random().toString(), sender: 'assistant', text: `처리 실패: ${err.message}`, timestamp: new Date() },
      ]);
    }
  };

  // ─── 연결 상태 스타일 ──────────────────────────────────────
  const statusColor =
    connectionStatus === 'connected'   ? 'text-emerald-400' :
    connectionStatus === 'connecting'  ? 'text-amber-400'   : 'text-slate-500';

  const statusDot =
    connectionStatus === 'connected'   ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' :
    connectionStatus === 'connecting'  ? 'bg-amber-400 animate-pulse'                             : 'bg-slate-600';

  const statusLabel =
    connectionStatus === 'connected'   ? '연결됨' :
    connectionStatus === 'connecting'  ? '연결중...' : '미연결';

  // ─── 렌더 ────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-black text-white overflow-x-hidden">

      {/* ── 고정 상단 네비게이션 바 ── */}
      <motion.nav
        initial={{ y: -60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-3 backdrop-blur-xl bg-black/60 border-b border-white/[0.06]"
      >
        {/* 로고 */}
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-violet-600/20 border border-violet-500/30">
            <Eye className="w-4 h-4 text-violet-400" />
          </div>
          <span className="text-sm font-bold tracking-tight bg-gradient-to-r from-white to-violet-300 bg-clip-text text-transparent">
            HuskyVision AI
          </span>
        </div>

        {/* 연결 상태 + 버튼 그룹 */}
        <div className="flex items-center gap-2">
          {/* 현재 연결 상태 칩 */}
          <div className="hidden md:flex items-center gap-2 bg-white/[0.04] border border-white/[0.08] rounded-full px-3 py-1.5">
            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot}`} />
            <span className={`text-xs font-mono truncate max-w-[160px] ${statusColor}`}
              title={mcpUrl}>
              {huskyIp}
            </span>
            <span className={`text-[10px] font-semibold ${statusColor}`}>{statusLabel}</span>
          </div>

          {/* 연결/해제 버튼 */}
          {connectionStatus === 'connected' ? (
            <button
              onClick={manualDisconnect}
              className="text-xs font-semibold px-3 py-1.5 rounded-full border border-emerald-500/40 text-emerald-400 bg-emerald-950/30 transition-all cursor-pointer hover:border-red-500/40 hover:text-red-400 hover:bg-red-950/30"
            >
              <span className="flex items-center gap-1.5">
                <Wifi className="w-3 h-3" />연결 해제
              </span>
            </button>
          ) : (
            <button
              onClick={() => manualConnect()}
              disabled={connectionStatus === 'connecting'}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-all cursor-pointer ${
                connectionStatus === 'connecting'
                  ? 'border-amber-500/40 text-amber-400 bg-amber-950/20'
                  : 'border-white/10 text-slate-300 hover:border-violet-500/40 hover:text-violet-300 bg-white/[0.03]'
              }`}
            >
              {connectionStatus === 'connecting' ? (
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin inline-block" />
                  연결중...
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <WifiOff className="w-3 h-3" />연결
                </span>
              )}
            </button>
          )}

          {/* ⚙️ 기기 설정 버튼 */}
          <button
            onClick={() => {
              setDraftMcpUrl(mcpUrl);
              setDraftRtspUrl(rtspUrl);
              setDraftBrokerUrl(brokerUrl);
              setDraftConnectionMode(connectionMode);
              setDraftDirectWebrtcUrl(directWebrtcUrl);
              setShowSettings(true);
            }}
            className="text-xs font-semibold px-3 py-1.5 rounded-full border border-white/10 text-slate-300 hover:border-violet-500/40 hover:text-violet-300 bg-white/[0.03] transition-all cursor-pointer flex items-center gap-1.5"
          >
            <Settings className="w-3 h-3" />기기 설정
          </button>

          {/* 💬 AI 채팅 버튼 */}
          <button
            onClick={() => setShowControlPanel(true)}
            className="text-xs font-semibold px-3 py-1.5 rounded-full border border-white/10 text-slate-300 hover:border-violet-500/40 hover:text-violet-300 bg-white/[0.03] transition-all cursor-pointer flex items-center gap-1.5"
          >
            <MessageSquare className="w-3 h-3" />AI 채팅
          </button>
        </div>
      </motion.nav>

      {/* ── 히어로 스크롤 섹션 ── */}
      <ContainerScroll
        style={{ background: 'linear-gradient(180deg, #000000 0%, #09050f 40%, #0d0620 100%)' }}
        className="pt-20 text-center text-white"
      >
        {/* 배경 글로우 */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-violet-600/10 blur-[120px] rounded-full" />
          <div className="absolute top-1/3 left-1/3 w-[300px] h-[200px] bg-indigo-600/8 blur-[100px] rounded-full" />
        </div>

        {/* 히어로 텍스트 */}
        <ContainerStagger className="relative z-10 px-6 pb-10">
          <ContainerAnimated animation="top">
            <div className="inline-flex items-center gap-2 bg-violet-600/10 border border-violet-500/20 text-violet-300 text-xs font-semibold px-4 py-1.5 rounded-full mb-6 mx-auto">
              <Zap className="w-3 h-3" />
              HuskyLens 2 × Gemini AI Vision
            </div>
          </ContainerAnimated>

          <ContainerAnimated animation="top">
            <h1 className="text-5xl md:text-7xl font-black leading-none tracking-tighter mb-4">
              <span className="block text-white">실시간 AI</span>
              <span className="block bg-gradient-to-r from-violet-400 via-purple-300 to-indigo-400 bg-clip-text text-transparent">
                비전 스테이션
              </span>
            </h1>
          </ContainerAnimated>

          <ContainerAnimated animation="blur" className="my-6">
            <p className="text-lg md:text-xl text-slate-400 leading-relaxed max-w-xl mx-auto">
              허스키렌즈2의 카메라를{' '}
              <span className="text-violet-300 font-semibold">WebRTC 초저지연</span>으로
              무선 스트리밍하고,{' '}
              <span className="text-violet-300 font-semibold">Gemini AI</span>가
              화면의 모든 것을 분석합니다.
            </p>
          </ContainerAnimated>

          <ContainerAnimated animation="bottom" className="flex justify-center gap-3 flex-wrap">
            {!isStreaming ? (
              <button
                onClick={startStreaming}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm transition-all shadow-[0_0_30px_rgba(139,92,246,0.4)] hover:shadow-[0_0_40px_rgba(139,92,246,0.6)] active:scale-95 cursor-pointer"
              >
                <Play className="w-4 h-4" />스트리밍 시작
              </button>
            ) : (
              <button
                onClick={stopStreaming}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-red-600/80 hover:bg-red-500 text-white font-semibold text-sm transition-all active:scale-95 cursor-pointer"
              >
                <Square className="w-4 h-4" />스트리밍 중단
              </button>
            )}
            <button
              onClick={() => setShowControlPanel(true)}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-white/15 hover:border-violet-500/50 text-slate-200 hover:text-violet-300 font-semibold text-sm transition-all active:scale-95 cursor-pointer"
            >
              <Sparkles className="w-4 h-4" />AI와 대화하기
            </button>
          </ContainerAnimated>

          {/* 상태 뱃지 */}
          <ContainerAnimated animation="blur" className="mt-6 flex justify-center gap-4 flex-wrap text-xs">
            <span className={`flex items-center gap-1.5 font-semibold ${statusColor}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
              {connectionStatus === 'connected'
                ? `${huskyIp} 연결됨`
                : connectionStatus === 'connecting'
                ? '연결 중...'
                : '오프라인'}
            </span>
            {isStreaming && (
              <span className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                LIVE 스트리밍 중
              </span>
            )}
          </ContainerAnimated>
        </ContainerStagger>

        {/* ── 스크롤 연동 영상 인셋 ── */}
        <ContainerInset
          insetXRange={[28, 0]}
          insetYRange={[25, 0]}
          roundednessRange={[800, 12]}
          className="mx-4 md:mx-10 shadow-[0_40px_120px_rgba(0,0,0,0.8)]"
        >
          <div className="relative w-full bg-[#030208] aspect-video rounded-2xl overflow-hidden border border-white/[0.06]">
            {isStreaming && streamType === 'video' && (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover transition-all duration-700 opacity-100"
              />
            )}

            {isStreaming && streamType === 'iframe' && (
              <iframe
                src={getIframeUrl(directWebrtcUrl)}
                className="w-full h-full border-0 bg-black rounded-2xl opacity-100"
                allow="autoplay; encrypted-media"
              />
            )}

            {isStreaming && streamType === 'mjpeg' && (
              <img
                src={getMjpegUrl(directWebrtcUrl)}
                alt="HuskyLens Live Stream"
                className="w-full h-full object-cover opacity-100"
                onError={() => {
                  console.error('MJPEG loading failed, fallback to iframe');
                  setStreamType('iframe');
                  addSystemMessage('⚠️ MJPEG 스트림 로드 실패로 iframe 뷰어로 자동 전환합니다.');
                }}
              />
            )}

            {/* 스트리밍 대기 화면 */}
            {!isStreaming && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#0a0512] to-[#030208]">
                <div className="relative mb-5">
                  <div className="absolute inset-0 rounded-full bg-violet-600/20 blur-xl animate-pulse" />
                  <div className="relative p-5 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                    <Cpu className="w-12 h-12 text-violet-400/50" />
                  </div>
                </div>
                <p className="text-slate-400 font-semibold text-sm">RTSP · WebRTC 스트리밍 대기 중</p>
                <p className="text-slate-600 text-xs mt-1">스트리밍 시작 버튼을 눌러 화면을 켜세요</p>
                <div
                  className="absolute inset-0 opacity-[0.03]"
                  style={{
                    backgroundImage:
                      'linear-gradient(rgba(139,92,246,1) 1px, transparent 1px), linear-gradient(90deg, rgba(139,92,246,1) 1px, transparent 1px)',
                    backgroundSize: '40px 40px',
                  }}
                />
              </div>
            )}

            {/* 바운딩 박스 */}
            {isStreaming && (
              <div className="absolute inset-0 pointer-events-none z-20">
                {detectedObjects.map((obj) => (
                  <div
                    key={obj.id}
                    className="absolute border border-violet-500/80 bg-violet-500/[0.04] transition-all duration-300"
                    style={{ left: `${obj.x}%`, top: `${obj.y}%`, width: `${obj.width}%`, height: `${obj.height}%` }}
                  >
                    <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-violet-400 -mt-px -ml-px" />
                    <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-violet-400 -mt-px -mr-px" />
                    <div className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-violet-400 -mb-px -ml-px" />
                    <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-violet-400 -mb-px -mr-px" />
                    <span className="absolute -top-5 left-0 bg-violet-900/90 text-violet-200 text-[9px] font-bold px-1.5 py-0.5 rounded tracking-wider uppercase">
                      {obj.label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* LIVE 뱃지 */}
            {isStreaming && (
              <div className="absolute top-3 left-3 z-30 flex items-center gap-1.5 bg-black/60 backdrop-blur-sm border border-red-500/40 px-2.5 py-1 rounded-full">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-xs font-bold text-red-400 tracking-wider">LIVE</span>
              </div>
            )}

            {/* 🔴 스트리밍 에러 및 보안 경고 모달 오버레이 */}
            {streamError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0c0817]/98 backdrop-blur-md z-40 p-6 text-center overflow-y-auto">
                <div className="p-3 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 mb-3 animate-pulse">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <h4 className="text-sm font-bold text-red-300 mb-1">스트리밍 송출 장애 감지</h4>
                <p className="text-[10px] text-slate-400 max-w-sm mb-4 leading-relaxed font-mono">
                  {streamError}
                </p>

                <div className="w-full max-w-md space-y-3">
                  {connectionMode === 'direct' && (
                    <>
                      {/* CORS 보안 장벽을 우회하는 극약 처방 3종 세트! */}
                      <div className="space-y-2">
                        <button
                          onClick={() => {
                            setStreamType('iframe');
                            setStreamError('');
                            setIsStreaming(true);
                            addSystemMessage('🚀 CORS 우회: 기기 순정 뷰어를 웹앱 내부(iframe)에 임베딩하여 연동합니다.');
                          }}
                          className="block w-full py-3 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-bold text-xs tracking-wider shadow-[0_0_20px_rgba(139,92,246,0.3)] transition-all transform hover:scale-[1.01] active:scale-[0.99] text-center cursor-pointer"
                        >
                          🖥️ [CORS 우회 1순위] 웹앱 내부(iframe)로 화면 연동하기
                        </button>

                        <button
                          onClick={() => {
                            setStreamType('mjpeg');
                            setStreamError('');
                            setIsStreaming(true);
                            addSystemMessage('🚀 CORS 우회: MJPEG 이미지 스트리밍 모드로 전환하여 연동합니다.');
                          }}
                          className="block w-full py-3 rounded-xl bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 text-white font-bold text-xs tracking-wider shadow-[0_0_20px_rgba(217,70,239,0.3)] transition-all transform hover:scale-[1.01] active:scale-[0.99] text-center cursor-pointer"
                        >
                          🖼️ [CORS 우회 2순위] MJPEG 이미지 스트림으로 연동하기
                        </button>

                        <a
                          href={`http://${huskyIp}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block w-full py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 border border-white/10 font-bold text-xs tracking-wider transition-all transform hover:scale-[1.01] active:scale-[0.99] text-center"
                        >
                          🚀 [대안] 기기 순정 스트리밍 화면 새 창으로 직접 열기
                        </a>
                      </div>

                      <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-3.5 text-left text-[11px] leading-relaxed text-slate-300 space-y-2">
                        <p className="font-semibold text-violet-300 flex items-center gap-1">
                          <span>💡 왜 안 되나요? (안내 가이드를 완료한 경우)</span>
                        </p>
                        <p className="text-slate-400 leading-normal">
                          크롬 사이트 설정에서 <strong>[안전하지 않은 콘텐츠] → '허용'</strong>을 올바르게 변경하셨음에도 송출이 되지 않는다면, 이는 기기 내장 WebRTC 서버의 <strong>CORS(교차 출처 자원 공유) 보안 제약</strong>으로 인해 브라우저의 직접 호출이 차단되었기 때문입니다.
                        </p>
                        <p className="text-slate-400 leading-normal">
                          위의 <strong>[CORS 우회 1/2순위]</strong> 버튼을 클릭하시면 브라우저 보안 및 CORS 제약을 100% 완벽하게 우회하여, 별도 프로그램 설치 없이 웹앱 플레이어 영역 내부에서 실시간 영상을 즉각 확인하실 수 있습니다!
                        </p>
                      </div>
                    </>
                  )}

                  {connectionMode === 'broker' && (
                    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-3.5 text-left text-[11px] leading-relaxed text-slate-300 space-y-1.5">
                      <p className="font-semibold text-violet-300">💡 로컬 중계 서버 가이드</p>
                      <p className="text-slate-400 leading-normal">
                        중계 서버를 통해 원격 송출을 할 경우, 반드시 PC의 터미널 창에 <code>node scripts/stream-broker.js</code>가 실행 중인지 확인해주세요.
                      </p>
                      <p className="text-slate-400 leading-normal">
                        외부망(Netlify)에서 Mixed Content 및 CORS 규격 제약 없이 전 세계 어디서든 안전하게 송출하려면 <strong>[⚙️ 기기 설정] 모달에서 중계 서버 주소에 ngrok 터널링 주소(HTTPS)</strong>를 알맞게 대입해주세요.
                      </p>
                    </div>
                  )}

                  {/* 하단 제어 버튼 */}
                  <div className="flex gap-2 justify-center pt-2">
                    <button
                      onClick={() => { setStreamError(''); startStreaming(); }}
                      className="flex-1 py-2 rounded-xl bg-white/[0.04] text-slate-300 border border-white/10 hover:bg-white/[0.08] text-xs font-semibold transition-all cursor-pointer"
                    >
                      다시 스캔 시도
                    </button>
                    <button
                      onClick={() => {
                        setStreamError('');
                        setIsStreaming(false);
                      }}
                      className="flex-1 py-2 rounded-xl bg-red-950/40 text-red-400 border border-red-800/40 hover:bg-red-900/30 text-xs font-semibold transition-all cursor-pointer"
                    >
                      중단
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </ContainerInset>
      </ContainerScroll>

      {/* ── 하단 기능 소개 섹션 ── */}
      <section className="bg-black py-20 px-6">
        <div className="max-w-5xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="text-center mb-14"
          >
            <h2 className="text-3xl md:text-4xl font-black tracking-tighter text-white mb-3">
              AI가 <span className="text-violet-400">눈</span>이 됩니다
            </h2>
            <p className="text-slate-500 text-sm max-w-md mx-auto">
              허스키렌즈2가 인식한 객체를 Gemini AI가 실시간으로 분석하고 자연어로 답변합니다.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              {
                icon: Eye,
                title: '실시간 비전 스트리밍',
                desc: 'RTSP 영상을 WebRTC로 변환하여 초저지연으로 브라우저에 전송합니다.',
                color: 'text-violet-400',
                glow: 'bg-violet-600/10 border-violet-500/20',
              },
              {
                icon: Sparkles,
                title: 'Gemini AI 분석',
                desc: '화면에 보이는 객체, 상황, 텍스트를 자연어로 설명하고 질문에 답합니다.',
                color: 'text-indigo-400',
                glow: 'bg-indigo-600/10 border-indigo-500/20',
              },
              {
                icon: Mic,
                title: '음성 제어 지원',
                desc: '마이크 버튼으로 음성 명령을 내리거나 채팅으로 AI에게 질문할 수 있습니다.',
                color: 'text-purple-400',
                glow: 'bg-purple-600/10 border-purple-500/20',
              },
            ].map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.15, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className={`p-6 rounded-2xl border ${item.glow} bg-white/[0.02] backdrop-blur-sm`}
              >
                <div className={`p-2.5 rounded-xl ${item.glow} border inline-block mb-4`}>
                  <item.icon className={`w-5 h-5 ${item.color}`} />
                </div>
                <h3 className="text-sm font-bold text-white mb-2">{item.title}</h3>
                <p className="text-xs text-slate-500 leading-relaxed">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════
          ── 기기 설정 모달 ──
          ════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {showSettings && (
          <>
            {/* 배경 오버레이 */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[110] cursor-pointer"
              onClick={() => setShowSettings(false)}
            />

            {/* 모달 */}
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 20 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="fixed inset-0 flex items-center justify-center z-[111] pointer-events-none px-4"
            >
              <div className="pointer-events-auto w-full max-w-md bg-[#0c0918]/95 backdrop-blur-2xl border border-white/[0.08] rounded-2xl shadow-[0_40px_100px_rgba(0,0,0,0.8)] overflow-hidden">

                {/* 모달 헤더 */}
                <div className="flex items-center justify-between p-5 border-b border-white/[0.06]">
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-violet-600/20 border border-violet-500/30">
                      <Settings className="w-4 h-4 text-violet-400" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-white">기기 연결 설정</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">MCP 주소와 RTSP 주소를 입력하세요</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowSettings(false)}
                    className="text-slate-500 hover:text-white transition-colors cursor-pointer p-1"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* 모달 바디 */}
                <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">

                  {/* 연결 방식 셀렉터 탭 */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-2">
                      연결 방식 (Connection Mode)
                    </label>
                    <div className="flex bg-white/[0.03] border border-white/[0.08] rounded-xl p-1 gap-1">
                      <button
                        type="button"
                        onClick={() => setDraftConnectionMode('broker')}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                          draftConnectionMode === 'broker'
                            ? 'bg-violet-600 text-white shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        중계 서버 경유 (원격 추천)
                      </button>
                      <button
                        type="button"
                        onClick={() => setDraftConnectionMode('direct')}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                          draftConnectionMode === 'direct'
                            ? 'bg-violet-600 text-white shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        기기 직접 연결 (동일 Wi-Fi)
                      </button>
                    </div>
                  </div>

                  {draftConnectionMode === 'broker' ? (
                    <>
                      {/* 중계 서버 주소 입력 */}
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-2">
                          중계 서버 주소 (Broker Base URL)
                        </label>
                        <input
                          type="text"
                          value={draftBrokerUrl}
                          onChange={(e) => setDraftBrokerUrl(e.target.value)}
                          placeholder="공란(로컬 구동) 또는 https://xxxx.ngrok-free.app"
                          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white font-mono placeholder-slate-600 outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-all"
                        />
                        <div className="flex items-start gap-1.5 mt-2">
                          <Info className="w-3 h-3 text-slate-600 flex-shrink-0 mt-0.5" />
                          <p className="text-[10px] text-slate-600 leading-relaxed">
                            로컬 PC에서 실행할 때는 공란으로 비워두세요.<br />
                            <span className="text-violet-400 font-semibold">Netlify 외부 원격 송출 시:</span> 로컬 PC에서 <span className="text-slate-400 font-mono">ngrok http 9999</span>를 가동한 뒤 생성된 <span className="text-violet-400 font-semibold font-mono">HTTPS</span> 터널 주소를 넣어주세요.
                          </p>
                        </div>
                      </div>

                      {/* RTSP 주소 입력 */}
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-2">
                          RTSP 스트림 주소
                        </label>
                        <input
                          type="text"
                          value={draftRtspUrl}
                          onChange={(e) => setDraftRtspUrl(e.target.value)}
                          placeholder="rtsp://10.161.176.236:8554/live"
                          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white font-mono placeholder-slate-600 outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-all"
                        />
                        <div className="flex items-start gap-1.5 mt-2">
                          <Info className="w-3 h-3 text-slate-600 flex-shrink-0 mt-0.5" />
                          <p className="text-[10px] text-slate-600 leading-relaxed">
                            기기 메뉴 → Video Streaming → RTSP Streaming이 ON이어야 합니다.<br />
                            기본 형식: <span className="text-slate-500 font-mono">rtsp://&lt;IP&gt;:8554/live</span>
                          </p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      {/* 기기 직접 WebRTC 시그널링 URL 입력 */}
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-2">
                          기기 WebRTC 시그널링 URL
                        </label>
                        <input
                          type="text"
                          value={draftDirectWebrtcUrl}
                          onChange={(e) => setDraftDirectWebrtcUrl(e.target.value)}
                          placeholder="http://10.161.176.236:1984/api/webrtc?src=camera"
                          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white font-mono placeholder-slate-600 outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-all"
                        />
                        <div className="flex items-start gap-1.5 mt-2">
                          <Info className="w-3 h-3 text-slate-600 flex-shrink-0 mt-0.5" />
                          <p className="text-[10px] text-slate-600 leading-relaxed">
                            <span className="text-violet-400 font-semibold">로컬 PC 중계기 없이 다이렉트 연동:</span> 기기 메뉴 → [Video Streaming] → [WebRTC Streaming]을 ON으로 켜고 표시되는 IP를 입력하세요.<br />
                            기본 포트: <span className="text-slate-500 font-mono">1984</span>
                          </p>
                        </div>
                      </div>
                    </>
                  )}

                  {/* MCP 주소 입력 */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-2">
                      MCP 서버 주소 (SSE)
                    </label>
                    <input
                      type="text"
                      value={draftMcpUrl}
                      onChange={(e) => setDraftMcpUrl(e.target.value)}
                      placeholder="http://10.161.176.236:3000/sse"
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white font-mono placeholder-slate-600 outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-all"
                    />
                    <div className="flex items-start gap-1.5 mt-2">
                      <Info className="w-3 h-3 text-slate-600 flex-shrink-0 mt-0.5" />
                      <p className="text-[10px] text-slate-600 leading-relaxed">
                        허스키렌즈2가 연결된 Wi-Fi IP와 포트를 입력하세요.<br />
                        기본 형식: <span className="text-slate-500 font-mono">http://&lt;IP&gt;:3000/sse</span>
                      </p>
                    </div>
                  </div>

                  {/* 현재 연결 상태 표시 */}
                  <div className={`flex items-center gap-2.5 p-3 rounded-xl border ${
                    connectionStatus === 'connected'
                      ? 'bg-emerald-950/30 border-emerald-800/40'
                      : connectionError
                        ? 'bg-red-950/20 border-red-800/30'
                        : 'bg-white/[0.02] border-white/[0.06]'
                  }`}>
                    {connectionStatus === 'connected' ? (
                      <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    ) : connectionError ? (
                      <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-slate-500 flex-shrink-0" />
                    )}
                    <div>
                      <p className={`text-xs font-semibold ${
                        connectionStatus === 'connected' ? 'text-emerald-300'
                          : connectionError ? 'text-red-300'
                          : connectionStatus === 'connecting' ? 'text-amber-300'
                          : 'text-slate-400'
                      }`}>
                        {connectionStatus === 'connected' ? '현재 연결됨'
                          : connectionStatus === 'connecting' ? '연결 시도 중...'
                          : connectionError ? '연결 실패'
                          : '미연결 상태'}
                      </p>
                      <p className={`text-[10px] font-mono truncate max-w-[300px] ${
                        connectionError ? 'text-red-400/70' : 'text-slate-600'
                      }`}
                        title={connectionError || mcpUrl}>
                        {connectionError || mcpUrl}
                      </p>
                    </div>
                  </div>
                </div>

                {/* 모달 푸터 */}
                <div className="flex items-center gap-2.5 px-5 pb-5">
                  <button
                    onClick={() => setShowSettings(false)}
                    className="flex-1 py-2.5 rounded-xl border border-white/[0.08] text-slate-400 text-sm font-semibold hover:bg-white/[0.04] transition-all cursor-pointer"
                  >
                    취소
                  </button>
                  <button
                    onClick={applySettings}
                    className="flex-1 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold transition-all shadow-[0_0_20px_rgba(139,92,246,0.3)] active:scale-[0.98] cursor-pointer flex items-center justify-center gap-2"
                  >
                    <Wifi className="w-3.5 h-3.5" />
                    저장 후 연결
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ════════════════════════════════════════════════════════
          ── AI 채팅 패널 ──
          ════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {showControlPanel && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 z-[99] cursor-pointer"
              onClick={() => setShowControlPanel(false)}
            />
            <motion.div
              initial={{ opacity: 0, x: 400 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 400 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-sm z-[100] flex flex-col bg-[#08050f]/95 backdrop-blur-2xl border-l border-white/[0.06] shadow-[-40px_0_80px_rgba(0,0,0,0.7)]"
            >
              {/* 패널 헤더 */}
              <div className="flex items-center justify-between p-4 border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-violet-600/20 border border-violet-500/30">
                    <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white">Gemini AI 비전 비서</p>
                    <p className="text-[10px] text-slate-500">gemini-3.1-flash-lite · {huskyIp}</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowControlPanel(false)}
                  className="text-slate-500 hover:text-white transition-colors cursor-pointer p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* 메시지 영역 */}
              <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-3">
                {messages.map((msg) => {
                  if (msg.sender === 'system') {
                    return (
                      <div key={msg.id} className="text-center my-0.5">
                        <span className="inline-block px-2.5 py-0.5 rounded-full text-[9px] font-medium bg-white/[0.03] text-slate-500 border border-white/[0.05]">
                          {msg.text}
                        </span>
                      </div>
                    );
                  }
                  const isUser = msg.sender === 'user';
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col max-w-[85%] ${isUser ? 'self-end items-end' : 'self-start items-start'}`}
                    >
                      <div
                        className={`p-3 rounded-xl text-xs leading-relaxed ${
                          isUser
                            ? 'bg-violet-600/20 border border-violet-500/30 text-violet-100 rounded-tr-none'
                            : 'bg-white/[0.04] border border-white/[0.07] text-slate-200 rounded-tl-none'
                        }`}
                      >
                        {msg.text}
                      </div>
                      <span className="text-[9px] text-slate-600 mt-1 px-1">
                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  );
                })}
                <div ref={chatBottomRef} />
              </div>

              {/* 입력 바 */}
              <div className="p-3 border-t border-white/[0.06]">
                <div className="flex items-center gap-2 bg-white/[0.03] border border-white/[0.07] rounded-xl p-1.5 focus-within:border-violet-500/40 transition-all">
                  <div className="relative">
                    {isListening && (
                      <div className="absolute inset-0 rounded-lg bg-violet-600/20 animate-ping pointer-events-none" />
                    )}
                    <button
                      onClick={toggleListening}
                      className={`p-2 rounded-lg transition-all relative z-10 cursor-pointer ${
                        isListening
                          ? 'bg-violet-600/30 text-white border border-violet-500/50'
                          : 'text-slate-500 hover:text-violet-300'
                      }`}
                    >
                      {isListening ? (
                        <div className="flex items-center gap-0.5 w-4 h-4">
                          <span className="w-0.5 h-3 bg-white animate-bounce [animation-delay:0.1s]" />
                          <span className="w-0.5 h-3 bg-white animate-bounce [animation-delay:0.2s]" />
                          <span className="w-0.5 h-3 bg-white animate-bounce [animation-delay:0.3s]" />
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
                    placeholder={isListening ? '음성 인식 중...' : '화면에 보이는 게 뭐야?'}
                    className="flex-1 bg-transparent text-xs text-slate-200 outline-none placeholder-slate-600 border-none"
                    disabled={isListening}
                  />

                  <button
                    onClick={() => handleSendMessage()}
                    className="p-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-all active:scale-95 cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
