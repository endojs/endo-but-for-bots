// @ts-check

// This runs only in an independently bounded, one-shot helper. Listeners and
// model containers retain cap-drop ALL, including every later exec operation.
export const providerNetworkBootstrap = `
import fcntl, ipaddress, socket, struct, sys
address = str(ipaddress.IPv4Address(sys.argv[1]))
assert ipaddress.ip_address(address).is_global
assert not ipaddress.ip_address(address).is_multicast
assert [name for _, name in socket.if_nameindex()] == ['lo']
assert len(open('/proc/net/route').read().splitlines()) == 1
for line in open('/proc/net/if_inet6'):
    fields = line.split()
    assert fields[0] == '00000000000000000000000000000001' and fields[2] == '80' and fields[-1] == 'lo'
for line in open('/proc/net/ipv6_route'):
    fields = line.split()
    assert fields[-1] == 'lo'
    assert int(fields[-2], 16) & 0x200 or (fields[0] == '00000000000000000000000000000001' and fields[1] == '80')
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for operation, value in [(0x8916, address), (0x891c, '255.255.255.255')]:
    request = struct.pack('16sH2s4s8s', b'lo:endo', socket.AF_INET, b'\\0\\0', socket.inet_aton(value), b'\\0' * 8)
    fcntl.ioctl(sock.fileno(), operation, request)
sock.close()
assert [name for _, name in socket.if_nameindex()] == ['lo']
assert len(open('/proc/net/route').read().splitlines()) == 1
print('EndoPublicProxyAddressV1')
`;
harden(providerNetworkBootstrap);
