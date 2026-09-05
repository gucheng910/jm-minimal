import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.jmclient.app",
  appName: "JMClient",
  webDir: "dist",
  android: {
    allowMixedContent: false
  }
};

export default config;
