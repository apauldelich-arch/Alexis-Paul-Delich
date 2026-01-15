
export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface Message {
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
}

export interface IteroInfo {
  name: string;
  mission: string;
  wlpp: string;
  wasteTypes: string[];
}
