import { GoogleGenerativeAI, SchemaType, FunctionCallingMode } from '@google/generative-ai';

// Initialize the Google Gen AI client with Vite environment variable
const apiKey = import.meta.env.VITE_GEMINI_API_KEY || 'AIzaSyDoSULEU-Q94WyTKij_Bf25I2kMTvwz3wY';

const ai = new GoogleGenerativeAI(apiKey);

// Define the schema for changing HuskyLens CV modes
const changeModeDeclaration = {
  name: 'changeHuskyLensMode',
  description: 'Changes the active computer vision (CV) algorithm mode on the HuskyLens 2.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      mode: {
        type: SchemaType.STRING,
        description: 'The target computer vision algorithm mode to run.',
        enum: [
          'face_recognition',
          'object_recognition',
          'face_expression',
          'object_tracking',
          'line_tracking',
          'color_recognition',
          'tag_recognition'
        ]
      },
      parameter: {
        type: SchemaType.STRING,
        description: 'Optional target name, color name, or property to track/recognize (e.g. "red", "ball", "John").',
      }
    },
    required: ['mode']
  } as any
};

// Define the schema for learning a new object or face (Self-Learning)
const learnTargetDeclaration = {
  name: 'learnNewTarget',
  description: 'Commands the HuskyLens 2 to learn the object or face currently in the center of the camera view.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      targetName: {
        type: SchemaType.STRING,
        description: 'The label or name to assign to the newly learned face or object.'
      }
    },
    required: ['targetName']
  } as any
};

// System prompt to instruct Gemini to act as a smart Vision assistant
const systemInstruction = `
You are the AI brain of "HuskyVision AI Link", a premium visual control station for the HuskyLens 2 AI Camera.
Your job is to interpret natural language commands from the user and convert them into hardware action function calls, OR answer questions about the objects/faces currently visible in the camera frame.

Available Modes mapping guide for function calling:
- 안면인식, 얼굴인식, 누구인지 봐줘, 문앞에 누가왔어 -> face_recognition
- 사물인식, 물체인식, 앞에 뭐가있어 -> object_recognition
- 감정인식, 표정인식, 기분 분석해줘 -> face_expression
- 객체추적, 이거 쫓아가, 공 따라가 -> object_tracking
- 라인트래킹, 선 추적, 바닥 선 따라가 -> line_tracking
- 색상인식, 무슨 색이야, 컬러인식 -> color_recognition
- tag_recognition, QR코드인식, 마크인식 -> tag_recognition

Special Instructions for Real-time Vision QA:
1. When the user asks "지금 화면에 보이는 객체가 무엇이야?", "지금 뭐가 보여?", "앞에 있는 사람 기분은 어때?", "누가 보여?" or similar visual questions, you will receive the real-time camera state data prefixed in the message.
2. Read the provided [현재 허스키렌즈2 카메라 감지 정보] or [Camera State] block.
3. Formulate a friendly, direct, and polite Korean response detailing exactly what is currently detected.
4. If objects are detected, describe them clearly (e.g., "현재 화면에는 94% 신뢰도로 사람(Person)과 88% 신뢰도로 녹색 상자(Green Box)가 보입니다.").
5. If no objects are currently in the camera frame or the list is empty, state: "현재 카메라 화면에 감지된 객체가 없습니다."
6. Do NOT invoke function calls if the user is simply asking about what is currently visible on screen. Instead, respond with a direct conversational reply.
`;

export interface HuskyLensCommand {
  functionName: string;
  args: any;
  assistantResponse: string;
}

/**
 * Parses user natural language query using Gemini Function Calling
 * @param userQuery The natural language instruction from the user
 * @param visionContext Optional real-time object detection context from the hardware
 * @returns Parsed hardware command structure
 */
export async function parseNaturalLanguageCommand(userQuery: string, visionContext?: string): Promise<HuskyLensCommand> {
  if (!apiKey) {
    throw new Error('Gemini API Key is missing. Please add VITE_GEMINI_API_KEY to your .env.local file.');
  }

  try {
    const model = ai.getGenerativeModel({
      model: 'gemini-3.1-flash-lite',
      systemInstruction,
      tools: [{ functionDeclarations: [changeModeDeclaration, learnTargetDeclaration] }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } }
    });

    let promptText = userQuery;
    if (visionContext) {
      promptText = `[현재 허스키렌즈2 카메라 감지 정보: ${visionContext}]\n\n사용자 질문: ${userQuery}`;
    }

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: promptText }] }]
    });

    const response = result.response;
    const candidate = response.candidates?.[0];
    const functionCalls = candidate?.content?.parts?.filter((part: any) => part.functionCall);
    const textPart = candidate?.content?.parts?.find((part: any) => part.text);
    
    const assistantResponse = textPart?.text || '알겠습니다. 허스키렌즈2를 설정하겠습니다.';

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0].functionCall!;
      return {
        functionName: call.name,
        args: call.args,
        assistantResponse
      };
    }

    // Fallback if no function call was generated (conversational reply)
    return {
      functionName: 'conversational',
      args: {},
      assistantResponse
    };
  } catch (error) {
    console.error('Error in parseNaturalLanguageCommand:', error);
    throw error;
  }
}
