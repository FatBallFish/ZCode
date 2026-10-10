/**
 * sherpa-onnx-node（Apache-2.0）最小 ambient 类型声明：仅覆盖语音输入用到的 API。
 * 上游未随包发布 .d.ts（JS 包装层见 node_modules/sherpa-onnx-node/*.js）；
 * 配置字段名以 node_modules/sherpa-onnx-node/types.js 的 JSDoc typedef 为准。
 */

declare module "sherpa-onnx-node" {
  export interface SherpaFeatureConfig {
    sampleRate?: number;
    featureDim?: number;
  }

  export interface SherpaSenseVoiceModelConfig {
    model?: string;
    language?: string;
    useInverseTextNormalization?: number;
  }

  export interface SherpaQwen3AsrModelConfig {
    encoder?: string;
    decoder?: string;
    convFrontend?: string;
    /** 分词器目录（tokenizer/vocab.json + merges.txt + tokenizer_config.json）。 */
    tokenizer?: string;
  }

  export interface SherpaTransducerModelConfig {
    encoder?: string;
    decoder?: string;
    joiner?: string;
  }

  export interface SherpaOfflineModelConfig {
    senseVoice?: SherpaSenseVoiceModelConfig;
    qwen3Asr?: SherpaQwen3AsrModelConfig;
    transducer?: SherpaTransducerModelConfig;
    tokens?: string;
    numThreads?: number;
    debug?: boolean | number;
    provider?: string;
  }

  export interface SherpaOfflineRecognizerConfig {
    featConfig?: SherpaFeatureConfig;
    modelConfig?: SherpaOfflineModelConfig;
  }

  export interface SherpaOfflineRecognizerResult {
    text: string;
    timestamps?: number[];
    tokens?: string[];
  }

  export interface SherpaOfflineStream {
    acceptWaveform(waveform: { sampleRate: number; samples: Float32Array }): void;
  }

  export interface SherpaOfflineRecognizer {
    createStream(hotwords?: string): SherpaOfflineStream;
    decode(stream: SherpaOfflineStream): void;
    getResult(stream: SherpaOfflineStream): SherpaOfflineRecognizerResult;
  }

  export interface SherpaOnlineRecognizerConfig {
    featConfig?: SherpaFeatureConfig;
    modelConfig?: SherpaOfflineModelConfig;
    decodingMethod?: string;
    enableEndpoint?: boolean | number;
    rule1MinTrailingSilence?: number;
    rule2MinTrailingSilence?: number;
    rule3MinUtteranceLength?: number;
  }

  export interface SherpaOnlineRecognizerResult {
    text: string;
  }

  export interface SherpaOnlineStream {
    acceptWaveform(waveform: { sampleRate: number; samples: Float32Array }): void;
  }

  export interface SherpaOnlineRecognizer {
    createStream(): SherpaOnlineStream;
    decode(stream: SherpaOnlineStream): void;
    isReady(stream: SherpaOnlineStream): boolean;
    isEndpoint(stream: SherpaOnlineStream): boolean;
    getResult(stream: SherpaOnlineStream): SherpaOnlineRecognizerResult;
  }

  export interface SherpaVadConfig {
    sileroVad?: {
      model?: string;
      threshold?: number;
      minSilenceDuration?: number;
      minSpeechDuration?: number;
      windowSize?: number;
      maxSpeechDuration?: number;
    };
    sampleRate?: number;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }

  export interface SherpaSpeechSegment {
    start: number;
    samples: Float32Array;
  }

  export interface SherpaVad {
    acceptWaveform(samples: Float32Array | Float32Array[]): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    clear(): void;
    front(enableExternalBuffer?: boolean): SherpaSpeechSegment;
    reset(): void;
    flush(): void;
  }

  const sherpaOnnxNode: {
    OnlineRecognizer: new (config: SherpaOnlineRecognizerConfig) => SherpaOnlineRecognizer;
    OfflineRecognizer: new (config: SherpaOfflineRecognizerConfig) => SherpaOfflineRecognizer;
    Vad: new (config: SherpaVadConfig, bufferSizeInSeconds?: number) => SherpaVad;
    version?: string;
  };

  export default sherpaOnnxNode;
}
