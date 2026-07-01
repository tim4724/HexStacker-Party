import Foundation

/// An item the remote-driven focus menu can highlight and activate. Implemented
/// by MenuButton (text buttons) and MusicSwitch (the pause-screen toggle), so a
/// menu row can mix them.
protocol Focusable: AnyObject {
    var enabled: Bool { get }
    func setFocused(_ focused: Bool)
    func activate()
}
