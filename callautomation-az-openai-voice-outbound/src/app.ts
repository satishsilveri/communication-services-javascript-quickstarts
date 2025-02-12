import { config } from 'dotenv';
import express, { Application } from 'express';
import http from 'http';
import {
	CallAutomationClient,
	MediaStreamingOptions,
	CallInvite,
	CreateCallOptions,
	CallConnection
} from "@azure/communication-call-automation";
import { PhoneNumberIdentifier } from "@azure/communication-common";
import WebSocket from 'ws';
import { startConversation, initWebsocket, initAudioData, initCallerId, audioData } from './azureOpenAiService'
import { processWebsocketMessageAsync } from './mediaStreamingHandler'
import { v4 as uuidv4 } from 'uuid';

const fs = require('fs');

config();

const PORT = process.env.PORT;
const WS_PORT = process.env.WS_PORT;
const app: Application = express();

const server = http.createServer(app);

app.use(express.static('webpage'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let callConnectionId: string;
let callConnection: CallConnection;
let serverCallId: string;
let callee: PhoneNumberIdentifier;
let acsClient: CallAutomationClient;

// Function to collate base64 audio data
function collateBase64Audio(audioList) {

	console.log('before', audioList.slice(0,10))

	//sort audio data based on timestamp
	audioList.sort((a, b) => a.timeStamp - b.timeStamp);

	// Concatenate the base64 strings in sorted order
  	return audioList.map(item => item.audio).join(''); 
}


function saveBase64AsAudioFile(base64String, filename) {
	// Remove any base64 prefix (optional, if it exists)
	const base64Data = base64String.split(',')[1] || base64String;

	fs.writeFile('calltext.txt', base64Data, (err) => {
		if (err) {
		  console.error('Error saving file:', err);
		} else {
		  console.log('File saved successfully!');
		}
	  });
  
	// Convert the base64 string to a Buffer
	const buffer = Buffer.from(base64Data, 'base64');
  
	// Write the buffer to a file
	fs.writeFile(filename, buffer, (err) => {
	  if (err) {
		console.error('Error saving file:', err);
	  } else {
		console.log('File saved successfully!');
	  }
	});
}


async function createAcsClient() {
	const connectionString = process.env.CONNECTION_STRING || "";
	acsClient = new CallAutomationClient(connectionString);
	console.log("Initialized ACS Client.");
}

async function createOutboundCall() {
	const callInvite: CallInvite = {
		targetParticipant: callee,
		sourceCallIdNumber: {
			phoneNumber: process.env.ACS_RESOURCE_PHONE_NUMBER || "",
		},
	};

	//const websocketUrl = process.env.CALLBACK_URI.replace(/^https:\/\//, 'wss://');
	const uuid = uuidv4();
	const websocketUrl = `${process.env.WEBSOCKET_URL}?callerId=${uuid}`
	console.log(websocketUrl);

	const mediaStreamingOptions: MediaStreamingOptions = {
		transportUrl: websocketUrl,
		transportType: "websocket",
		contentType: "audio",
		audioChannelType: "unmixed",
		startMediaStreaming: true,
		enableBidirectional: true,
		audioFormat: "Pcm24KMono"
	};

	const createCallOptions: CreateCallOptions = {
		mediaStreamingOptions: mediaStreamingOptions
	};

	console.log("Placing outbound call...");
	acsClient.createCall(callInvite, process.env.CALLBACK_URI + "/api/callbacks", createCallOptions);
}

async function hangUpCall() {
	callConnection.hangUp(true);
}

// POST endpoint to handle ongoing call events
app.post("/api/callbacks", async (req: any, res: any) => {
	const event = req.body[0];
	const eventData = event.data;
	callConnectionId = eventData.callConnectionId;
	serverCallId = eventData.serverCallId;
	console.log("Call back event received, callConnectionId=%s, serverCallId=%s, eventType=%s", callConnectionId, serverCallId, event.type);
	callConnection = acsClient.getCallConnection(callConnectionId);
	const callMedia = callConnection.getCallMedia();
	if (event.type === "Microsoft.Communication.CallConnected") {
		console.log("Received CallConnected event");
	}

	else if (event.type === "Microsoft.Communication.MediaStreamingStarted") {
		console.log(`Operation context:--> ${eventData.operationContext}`);
		console.log(`Media streaming content type:--> ${eventData.mediaStreamingUpdate.contentType}`);
		console.log(`Media streaming status:--> ${eventData.mediaStreamingUpdate.mediaStreamingStatus}`);
		console.log(`Media streaming status details:--> ${eventData.mediaStreamingUpdate.mediaStreamingStatusDetails}`);
	}
	else if (event.type === "Microsoft.Communication.MediaStreamingStopped") {
		console.log(`Operation context:--> ${eventData.operationContext}`);
		console.log(`Media streaming content type:--> ${eventData.mediaStreamingUpdate.contentType}`);
		console.log(`Media streaming status:--> ${eventData.mediaStreamingUpdate.mediaStreamingStatus}`);
		console.log(`Media streaming status details:--> ${eventData.mediaStreamingUpdate.mediaStreamingStatusDetails}`);
	}
	else if (event.type === "Microsoft.Communication.MediaStreamingFailed") {
		console.log(`Operation context:--> ${eventData.operationContext}`);
		console.log(`Code:->${eventData.resultInformation.code}, Subcode:->${eventData.resultInformation.subCode}`)
		console.log(`Message:->${eventData.resultInformation.message}`);
	}
	else if (event.type === "Microsoft.Communication.CallDisconnected") {
		console.log('Call Disconnected');
		let audioDataString = collateBase64Audio(audioData);
		saveBase64AsAudioFile(audioDataString, "call.mp3")
		//hangUpCall()
	}

	res.sendStatus(200);

});

// GET endpoint to serve the webpage
app.get('/', (req, res) => {
	res.sendFile('index.html', { root: 'src/webpage' });
});

// GET endpoint to place phone call
app.get('/outboundCall', async (req, res) => {
	callee = {
		phoneNumber: process.env.TARGET_PHONE_NUMBER || "",
	};

	await createOutboundCall();
	res.redirect('/');
});

const wss = new WebSocket.Server({ port: WS_PORT });
wss.on('connection', async (ws: WebSocket, req : Request) => {
	console.log('Client connected!');
	let callerId = req.url.split("?callerId=")[1]
	console.log('Caller ID:', callerId);
	await initWebsocket(ws);
	await initAudioData([])
	await initCallerId(callerId);
	await startConversation()
	ws.on('message', async (packetData: ArrayBuffer) => {
		try {
			if (ws.readyState === WebSocket.OPEN) {
				await processWebsocketMessageAsync(packetData, callerId);
			} else {
				console.warn(`ReadyState: ${ws.readyState}`);
			}
		} catch (error) {
			console.error('Error processing WebSocket message:', error);
		}
	});
	ws.on('close', () => {
		console.log('Client disconnected');
	});
});

console.log(`WebSocket server running on port ${WS_PORT}`);

// Start the server
app.listen(PORT, async () => {
	console.log(`Server is listening on port ${PORT}`);
	await createAcsClient();
});