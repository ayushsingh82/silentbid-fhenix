import { getDefaultConfig } from "@rainbow-me/rainbowkit"
import { http } from "wagmi"
import { activeChain, activeTransport } from "./chain-config"

const projectId = process.env.PROJECT_ID || "a73ceeb8d8079b8c1dc4d9d5ebbc0433"

export const wagmiConfig = getDefaultConfig({
  appName: "SilentBid",
  projectId,
  chains: [activeChain],
  transports: {
    [activeChain.id]: activeTransport,
  },
  ssr: true,
})
