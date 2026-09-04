/// <reference types="vite/client" />

interface NavigatorUAData {
  readonly mobile: boolean;
  readonly platform: string;
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData;
}
