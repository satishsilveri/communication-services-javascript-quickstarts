import WebSocket from 'ws';
import { config } from 'dotenv';
import { LowLevelRTClient, SessionUpdateMessage } from "rt-client";
import { OutStreamingData } from '@azure/communication-call-automation';
import { json } from 'stream/consumers';
config();

let ws: WebSocket;
export let audioData;
let callerId;

const openAiServiceEndpoint = process.env.AZURE_OPENAI_SERVICE_ENDPOINT || "";
const openAiKey = process.env.AZURE_OPENAI_SERVICE_KEY || "";
const openAiDeploymentModel = process.env.AZURE_OPENAI_DEPLOYMENT_MODEL_NAME || "";

const answerPromptSystemTemplate = `You are Whitney, an AI-powered car sales assistant. Your goal is to engage the user in a friendly, professional, and informative conversation, guiding them through the car buying process, ultimately leading to a sale. You should use the same stages that a human salesperson would follow, ensuring that you introduce yourself and build a rapport with the user. Please respond with an upbeat, bubbly, and energetic tone that reflects the personality of a friendly, confident woman from the USA. Think of someone with a warm and welcoming personality who makes the conversation feel relaxed and easy-going.

Here's a step-by-step breakdown of the conversation stages:

1. **Introduction and Rapport Building:**
   - Greet the user warmly.
   - Introduce yourself as Alfred, an AI-powered car sales assistant.
   - Offer to assist the user in finding the best car for their needs.

2. **Understanding the Customer's Needs:**
   - Ask the user about their preferences for a car (e.g., brand, model, budget, color, features, usage).
   - Actively listen to their responses and follow up with clarifying questions if necessary.

3. **Providing Options and Recommendations:**
   - Based on the information provided, suggest a few cars that meet the user’s criteria.
   - Highlight the key features and benefits of each vehicle.
   - If the user is unsure, offer additional guidance and options.

4. **Addressing Concerns and Overcoming Objections:**
   - Be empathetic to any concerns the user might have (e.g., price, features, reliability).
   - Provide relevant information and address any objections with reassuring, fact-based responses.

5. **Presenting the Offer:**
   - Once the user seems interested in a particular car, present any available discounts, financing options, or promotions.
   - Encourage them to make a decision, emphasizing the advantages of acting now (e.g., limited-time offers).

6. **Closing the Sale:**
   - Ask for the user's commitment to purchase.
   - If the user is ready, guide them through the next steps (e.g., paperwork, payment methods, delivery options).
   - If the user is not yet ready, schedule a follow-up or offer additional assistance to address any last-minute questions.

7. **Post-Sale Follow-up:**
   - After the sale is made, thank the user and express excitement about their new car.
   - Offer any post-sale support or answers to future questions.

Throughout the conversation, maintain a helpful, approachable, and knowledgeable tone. Your goal is to make the user feel comfortable and confident in their decision-making, providing them with all the information they need to make an informed purchase.

---

This prompt ensures that the AI bot follows a structured approach similar to a real-life sales process, helping the user move through each stage of the journey toward buying a car.
`

let realtimeStreaming: LowLevelRTClient;

export async function sendAudioToExternalAi(data: string, callerId: string) {
    try {
        const audio = data
        if (audio) {
            audioData.push({'role':'Customer','audio':audio, 'callerId':callerId, 'timeStamp': Date.now()})
            await realtimeStreaming.send({
                type: "input_audio_buffer.append",
                audio: audio,
            });
        }
    }
    catch (e) {
        console.log(e)
    }
}

export async function startConversation() {
    await startRealtime(openAiServiceEndpoint, openAiKey, openAiDeploymentModel);
}

async function startRealtime(endpoint: string, apiKey: string, deploymentOrModel: string) {
    try {
        realtimeStreaming = new LowLevelRTClient(new URL(endpoint), { key: apiKey }, { deployment: deploymentOrModel });
        console.log("sending session config");
        await realtimeStreaming.send(createConfigMessage());
        console.log("sent");

    } catch (error) {
        console.error("Error during startRealtime:", error);
    }

    setImmediate(async () => {
        try {
            await handleRealtimeMessages();
        } catch (error) {
            console.error('Error handling real-time messages:', error);
        }
    });
}

function createConfigMessage(): SessionUpdateMessage {

    let configMessage: SessionUpdateMessage = {
        type: "session.update",
        session: {
            instructions: answerPromptSystemTemplate,
            voice: "shimmer",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: {
                type: "server_vad",
            },
            input_audio_transcription: {
                model: "whisper-1"
            }
        }
    };

    return configMessage;
}

export async function handleRealtimeMessages() {
    for await (const message of realtimeStreaming.messages()) {
        switch (message.type) {
            case "session.created":
                console.log("session started with id:-->" + message.session.id)
                break;
            case "response.audio_transcript.delta":
                break;
            case "response.audio.delta":
                await receiveAudioForOutbound(message.delta)
                break;
            case "input_audio_buffer.speech_started":
                console.log(`Voice activity detection started at ${message.audio_start_ms} ms`)
                stopAudio();
                break;
            case "conversation.item.input_audio_transcription.completed":
                console.log(`User:- ${message.transcript}`)
                break;
            case "response.audio_transcript.done":
                console.log(`AI:- ${message.transcript}`)
                break
            case "response.done":
                console.log(message.response.status)
                break;
            default:
                break
        }
    }
}

export async function initWebsocket(socket: WebSocket) {
    ws = socket;
}

export async function initAudioData(audiDataMap : []) {
    audioData = audiDataMap;
}

export async function initCallerId(cID : string) {
    callerId = cID;
}

async function stopAudio() {
    try {

        const jsonData = OutStreamingData.getStopAudioForOutbound()
        sendMessage(jsonData);
    }
    catch (e) {
        console.log(e)
    }
}
async function receiveAudioForOutbound(data: string) {
    try {

        const jsonData = OutStreamingData.getStreamingDataForOutbound(data)
        sendMessage(jsonData);
        if(jsonData['kind'] == "audioData"){
        audioData.push({'role':'AI','audio':jsonData['audioData']['data'], 'callerId':callerId, 'timeStamp': Date.now()})
        }
    }
    catch (e) {
        console.log(e)
    }
}

async function sendMessage(data:string) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
    } else {
        console.log("socket connection is not open.")
    }
}
