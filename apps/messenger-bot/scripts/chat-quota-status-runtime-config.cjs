const { ChatRuntimeConfig } = module.require('@wispace/chat-agent');

function createChatRuntimeConfig(env = process.env) {
  return new ChatRuntimeConfig(env);
}

module.exports = { createChatRuntimeConfig };
