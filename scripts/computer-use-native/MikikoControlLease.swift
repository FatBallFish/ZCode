import Foundation

/// 全局控制权由原生 App-agent 持有；只有 owner 清理完成才能交接，绝不按时间抢占。
final class MikikoControlLease: @unchecked Sendable {
    private let mutex = NSLock()
    private var owner: UUID?
    private var shutdownRequested = false
    private var connections = Set<UUID>()

    struct Busy: Error, CustomStringConvertible {
        var description: String { "Mikiko Computer Use busy: another connection owns desktop control." }
    }

    var isBusy: Bool {
        mutex.lock(); defer { mutex.unlock() }
        return owner != nil || shutdownRequested
    }

    func registerConnection(_ connection: UUID) -> Bool {
        mutex.lock(); defer { mutex.unlock() }
        guard !shutdownRequested else { return false }
        connections.insert(connection)
        return true
    }

    func closeConnection(_ connection: UUID, cleanup: () -> Void) -> Bool {
        release(connection, cleanup: cleanup)
        mutex.lock(); defer { mutex.unlock() }
        guard connections.remove(connection) != nil else { return false }
        guard connections.isEmpty && owner == nil else { return false }
        // 最后一个EOF在清理完成后关闭admission，防止App更新后残留旧签名进程占据socket。
        shutdownRequested = true
        return true
    }

    func acquire(_ connection: UUID) throws {
        mutex.lock(); defer { mutex.unlock() }
        guard !shutdownRequested && (owner == nil || owner == connection) else { throw Busy() }
        owner = connection
    }

    func requestShutdown() throws {
        mutex.lock(); defer { mutex.unlock() }
        guard owner == nil && !shutdownRequested else { throw Busy() }
        shutdownRequested = true
    }

    func release(_ connection: UUID, cleanup: () -> Void) {
        mutex.lock()
        guard owner == connection else { mutex.unlock(); return }
        mutex.unlock()
        // owner 保留到同步原生动作与缓存清理全部完成；只读连接关闭不能清别人的屏幕状态。
        cleanup()
        mutex.lock(); defer { mutex.unlock() }
        if owner == connection { owner = nil }
    }
}
