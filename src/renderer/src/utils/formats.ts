import { isReasoningModel } from '@renderer/config/models'
import { getAssistantById } from '@renderer/services/AssistantService'
import { Message } from '@renderer/types'

export function escapeDollarNumber(text: string) {
  let escapedText = ''

  for (let i = 0; i < text.length; i += 1) {
    let char = text[i]
    const nextChar = text[i + 1] || ' '

    if (char === '$' && nextChar >= '0' && nextChar <= '9') {
      char = '\\$'
    }

    escapedText += char
  }

  return escapedText
}

export function escapeBrackets(text: string) {
  const pattern = /(```[\s\S]*?```|`.*?`)|\\\[([\s\S]*?[^\\])\\\]|\\\((.*?)\\\)/g
  return text.replace(pattern, (match, codeBlock, squareBracket, roundBracket) => {
    if (codeBlock) {
      return codeBlock
    } else if (squareBracket) {
      return `
$$
${squareBracket}
$$
`
    } else if (roundBracket) {
      return `$${roundBracket}$`
    }
    return match
  })
}

export function extractTitle(html: string): string | null {
  const titleRegex = /<title>(.*?)<\/title>/i
  const match = html.match(titleRegex)

  if (match && match[1]) {
    return match[1].trim()
  }

  return null
}

export function removeSvgEmptyLines(text: string): string {
  // 用正则表达式匹配 <svg> 标签内的内容
  const svgPattern = /(<svg[\s\S]*?<\/svg>)/g

  return text.replace(svgPattern, (svgMatch) => {
    // 将 SVG 内容按行分割,过滤掉空行,然后重新组合
    return svgMatch
      .split('\n')
      .filter((line) => line.trim() !== '')
      .join('\n')
  })
}

export function withGeminiGrounding(message: Message) {
  const { groundingSupports } = message?.metadata?.groundingMetadata || {}

  if (!groundingSupports) {
    return message.content
  }

  let content = message.content

  groundingSupports.forEach((support) => {
    const text = support.segment.text
    const indices = support.groundingChunkIndices
    const nodes = indices.reduce((acc, index) => {
      acc.push(`<sup>${index + 1}</sup>`)
      return acc
    }, [])
    content = content.replace(text, `${text} ${nodes.join(' ')}`)
  })

  return content
}

interface ThoughtProcessor {
  canProcess: (content: string, message?: Message) => boolean
  process: (content: string) => { reasoning: string; content: string }
}

const glmZeroPreviewProcessor: ThoughtProcessor = {
  canProcess: (content: string, message?: Message) => {
    if (!message) return false

    const modelId = message.modelId || ''
    const modelName = message.model?.name || ''
    const isGLMZeroPreview =
      modelId.toLowerCase().includes('glm-zero-preview') || modelName.toLowerCase().includes('glm-zero-preview')

    return isGLMZeroPreview && content.includes('###Thinking')
  },
  process: (content: string) => {
    const parts = content.split('###')
    const thinkingMatch = parts.find((part) => part.trim().startsWith('Thinking'))
    const responseMatch = parts.find((part) => part.trim().startsWith('Response'))

    return {
      reasoning: thinkingMatch ? thinkingMatch.replace('Thinking', '').trim() : '',
      content: responseMatch ? responseMatch.replace('Response', '').trim() : ''
    }
  }
}

const thinkTagProcessor: ThoughtProcessor = {
  canProcess: (content: string, message?: Message) => {
    if (!message) return false

    return content.startsWith('<think>') || content.includes('</think>')
  },
  process: (content: string) => {
    // 处理正常闭合的 think 标签
    const thinkPattern = /^<think>(.*?)<\/think>/s
    const matches = content.match(thinkPattern)
    if (matches) {
      return {
        reasoning: matches[1].trim(),
        content: content.replace(thinkPattern, '').trim()
      }
    }

    // 处理只有结束标签的情况
    if (content.includes('</think>') && !content.startsWith('<think>')) {
      const parts = content.split('</think>')
      return {
        reasoning: parts[0].trim(),
        content: parts.slice(1).join('</think>').trim()
      }
    }

    // 处理只有开始标签的情况
    if (content.startsWith('<think>')) {
      return {
        reasoning: content.slice(7).trim(), // 跳过 '<think>' 标签
        content: ''
      }
    }

    return {
      reasoning: '',
      content
    }
  }
}

// 新增 detailsSummaryProcessor 处理器来处理图片中的格式
const detailsSummaryProcessor: ThoughtProcessor = {
  canProcess: (content: string, message?: Message) => {
    if (!message) return false
    
    // 检查是否处于发送中状态
    const isStreaming = message.status === 'sending' || message.status === 'pending';
    
    // 完整标签检查
    const hasCompleteTag = content.includes('<details') && 
                           content.includes('<summary>') && 
                           content.includes('</summary>') && 
                           content.includes('</details>');
    
    // 流式输出中的不完整标签检查
    const hasIncompleteTag = isStreaming && 
                            (content.includes('<details') && content.includes('<summary>'));
    
    return hasCompleteTag || hasIncompleteTag;
  },
  process: (content: string) => {
    // 匹配完整的 details 标签块
    const detailsPattern = /<details[^>]*>([\s\S]*?)<\/details>/;
    const detailsMatch = content.match(detailsPattern);
    
    if (detailsMatch) {
      // 处理完整标签的逻辑（保持不变）
      const detailsContent = detailsMatch[1].trim();
      const summaryPattern = /<summary>([\s\S]*?)<\/summary>([\s\S]*)/;
      const summaryMatch = detailsContent.match(summaryPattern);
      
      if (summaryMatch) {
        const reasoning = summaryMatch[2].trim();
        const processedContent = content.replace(detailsPattern, '').trim();
        
        return {
          reasoning: reasoning,
          content: processedContent
        };
      }
    } else if (content.includes('<details') && content.includes('<summary>')) {
      // 处理不完整标签的情况（流式输出）
      const summaryStartIndex = content.indexOf('<summary>') + 9;
      const summaryEndIndex = content.indexOf('</summary>');
      
      if (summaryEndIndex > summaryStartIndex) {
        // 如果 summary 标签已闭合，提取 summary 后的内容
        const reasoning = content.substring(summaryEndIndex + 10).trim();
        return {
          reasoning: reasoning,
          content: '' // 在思考中时，内容为空
        };
      } else {
        // 如果 summary 标签未闭合，提取 summary 后的内容
        const reasoning = content.substring(summaryStartIndex).trim();
        return {
          reasoning: reasoning,
          content: '' // 在思考中时，内容为空
        };
      }
    }
    
    return {
      reasoning: '',
      content
    };
  }
};

export function withMessageThought(message: Message) {
  if (message.role !== 'assistant') {
    return message
  }

  const model = message.model
  if (!model || !isReasoningModel(model)) return message

  const isClaude37Sonnet = model.id.includes('claude-3-7-sonnet') || model.id.includes('claude-3.7-sonnet')
  if (isClaude37Sonnet) {
    const assistant = getAssistantById(message.assistantId)
    if (!assistant?.settings?.reasoning_effort) return message
  }

  const content = message.content.trim()
  // 添加 detailsSummaryProcessor 到处理器列表中
  const processors: ThoughtProcessor[] = [detailsSummaryProcessor, glmZeroPreviewProcessor, thinkTagProcessor]

  const processor = processors.find((p) => p.canProcess(content, message))
  if (processor) {
    const { reasoning, content: processedContent } = processor.process(content)
    message.reasoning_content = reasoning
    message.content = processedContent
  }

  return message
}

export function withGenerateImage(message: Message) {
  const imagePattern = new RegExp(`!\\[[^\\]]*\\]\\((.*?)\\s*("(?:.*[^"])")?\\s*\\)`)
  const imageMatches = message.content.match(imagePattern)

  if (!imageMatches || imageMatches[1] === null) {
    return message
  }

  const cleanImgContent = message.content
    .replace(imagePattern, '')
    .replace(/\n\s*\n/g, '\n')
    .trim()

  const downloadPattern = new RegExp(`\\[[^\\]]*\\]\\((.*?)\\s*("(?:.*[^"])")?\\s*\\)`)
  const downloadMatches = cleanImgContent.match(downloadPattern)

  let cleanContent = cleanImgContent
  if (downloadMatches) {
    cleanContent = cleanImgContent
      .replace(downloadPattern, '')
      .replace(/\n\s*\n/g, '\n')
      .trim()
  }

  message = {
    ...message,
    content: cleanContent,
    metadata: {
      ...message.metadata,
      generateImage: {
        type: 'url',
        images: [imageMatches[1]]
      }
    }
  }
  return message
}

export function addImageFileToContents(messages: Message[]) {
  const lastAssistantMessage = messages.findLast((m) => m.role === 'assistant')
  if (!lastAssistantMessage || !lastAssistantMessage.metadata || !lastAssistantMessage.metadata.generateImage) {
    return messages
  }

  const imageFiles = lastAssistantMessage.metadata.generateImage.images
  const updatedAssistantMessage = {
    ...lastAssistantMessage,
    images: imageFiles
  }

  return messages.map((message) => (message.role === 'assistant' ? updatedAssistantMessage : message))
}
