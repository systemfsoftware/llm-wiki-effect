export const API_SERVER_PORT = 19828
export const API_SERVER_BASE_URL = `http://127.0.0.1:${API_SERVER_PORT}`

export const API_SERVER_REMOTE_BASE_URL = `http://<host>:${API_SERVER_PORT}`

export const API_RPC_PATH = '/rpc'
export const API_RPC_STREAM_PATH = '/rpc/stream'
export const API_RPC_URL = `${API_SERVER_BASE_URL}${API_RPC_PATH}`
export const API_RPC_STREAM_URL = `ws://127.0.0.1:${API_SERVER_PORT}${API_RPC_STREAM_PATH}`
