// QA only: synthesize one unbroken utterance to disk, never to an audio device.
// Word offsets from the synthesizer are independent of the wake detector.
import AVFoundation

let synth = AVSpeechSynthesizer()
let utterance = AVSpeechUtterance(string: CommandLine.arguments[2])
utterance.voice = AVSpeechSynthesisVoice.speechVoices().first {
    $0.language == "ru-RU" && $0.name == "Milena"
}
precondition(utterance.voice != nil, "Install the Russian Milena system voice")
utterance.rate = 0.5
let url = URL(fileURLWithPath: CommandLine.arguments[1])
var audio: AVAudioFile?
var done = false
var offsets: [Int: Int] = [:]
synth.write(utterance, toBufferCallback: { buf in
    let pcm = buf as! AVAudioPCMBuffer
    if pcm.frameLength == 0 { done = true; return }
    if audio == nil { audio = try! AVAudioFile(forWriting: url, settings: pcm.format.settings) }
    try! audio!.write(from: pcm)
}, toMarkerCallback: { markers in
    for m in markers where m.mark == .word { offsets[m.textRange.location] = m.byteSampleOffset }
})
let deadline = Date().addingTimeInterval(20)
while !done && Date() < deadline { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005)) }
precondition(done && offsets.keys.sorted() == [0, 6, 13], "Missing audio or word timing")
let format = audio!.processingFormat
let bytesPerSecond = format.sampleRate * Double(format.streamDescription.pointee.mBytesPerFrame)
audio = nil
print(Double(offsets[6]!) / bytesPerSecond) // start of «открой» approximates end of «Рейдж»
