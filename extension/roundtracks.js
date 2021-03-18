extensionId = api('createDialog',{title:'getId'})[0].id.split('-')[2]; // really bad hack to get the extension id ;)
extension = easyeda.extension.instances[extensionId];
const { kdtree, kdnear, kdinside, dot } = extension.line;

function RoundTracks(tracks, vias, board, args) {
    const maxCosTheta = Math.cos(Math.PI / 180 * args.minAngle);
    const radius = args.radius * 0.1;
    const maxRadius = args.maxRadius * 0.1;
    const minLength = args.minLength * 0.1;
    for(const t of tracks)
        t.i = 0; // iteration number
    // find all connected tracks
    var connections = findConnections(tracks, vias, args);
    // perform track subdivision smoothing algorithm as explained 
    // here https://mitxela.com/projects/melting_kicad           
    for(var smoothpass = 0; smoothpass < args.passes; ++smoothpass) {
        // save original lengths
        for(const t of tracks)
           t.originalLength = t.length;
        const nextPassIntersections = {};
        for(const [pos, tracksHere] of Object.values(connections)) {
            if (tracksHere.length < 2)
                continue;
            // flip tracks such that all tracks start at the intersection point
            for(const t of tracksHere)
                if (t.start.x != pos.x || t.start.y != pos.y)
                    t.reverse();
        
            // sort these tracks by angle, so new tracks can be drawn between them
            if (tracksHere.length > 2)
                tracksHere.sort((a, b) => a.angle() < b.angle());

            // find the largest angle between two tracks
            var cosAnglesBetweenTracks = []
            for(var t = 0; t < tracksHere.length; ++t) {
                const t0 = tracksHere[t];
                const t1 = tracksHere[(t + 1) % tracksHere.length];
                // skip pairs that won't be smoothed (see below)
                if (smoothpass == 0 || t0.i != t1.i)
                    cosAnglesBetweenTracks.push(Math.abs(dot(t0.dir, t1.dir)));
            }
            // skip if tracks already smooth/straight enough
            if (cosAnglesBetweenTracks.length == 0 ||
                Math.min(...cosAnglesBetweenTracks) > maxCosTheta)
                continue;
            
            // shorten all these tracks (push start points away from intersection point)
            const shortestTrackLen = Math.min(...tracksHere.map(t=>t.originalLength))
            var didSmoothing = false;
            for(var t = 0; t < tracksHere.length; ++t) {
                var t0 = tracksHere[t];
                const t1 = tracksHere[(t + 1) % tracksHere.length];
                const r = Math.min(maxRadius, radius + args.radiusWidthMultiplier * t0.width, t0.length - minLength);
                const cosHalfTheta = Math.sqrt(.5 + .5 * Math.abs(dot(t0.dir, t1.dir)));
                const amountToShorten = Math.min(shortestTrackLen / (2 * cosHalfTheta + 2), r);
                if (amountToShorten >= minLength) {
                    t0.length -= amountToShorten;
                    t0.start = t0.pointOnLine(amountToShorten);
                    if (!(t0.start in nextPassIntersections))
                        nextPassIntersections[t0.start] = [t0.start.clone(), []];
                    nextPassIntersections[t0.start][1].push(t0);
                    didSmoothing = true;                    
                }
            }

            if (!didSmoothing)
                continue;

            // connect the new start points in a circle around the old center point
            for(var t = 0; t < tracksHere.length; ++t) {
                const t0 = tracksHere[t];
                const t1 = tracksHere[(t + 1) % tracksHere.length];
                // don't add 2 new tracks in the 2 track case
                if (tracksHere.length > 2 || t == 0) {
                    // don't link two tracks that were both generated by a previous pass
                    // to stop 3+ way junctions going fractal
                    if (smoothpass == 0 || t0.i != t1.i) {
                        const thinTrack = (t0.width < t1.width ? t0 : t1);
                        var newTrack = thinTrack.clone();
                        newTrack.start = t0.start.clone();
                        newTrack.end = t1.start.clone();
                        newTrack.i = smoothpass + 1;
                        if (newTrack.update()) {
                            tracks.push(newTrack);
                            if (!(newTrack.start in nextPassIntersections))
                                nextPassIntersections[newTrack.start] = [newTrack.start.clone(), [newTrack]];
                            else
                                nextPassIntersections[newTrack.start][1].push(newTrack);
                            if (!(newTrack.end in nextPassIntersections))
                                nextPassIntersections[newTrack.end] = [newTrack.end.clone(), [newTrack]];
                            else
                                nextPassIntersections[newTrack.end][1].push(newTrack)
                        }
                    }
                }
            }
        }
        connections = nextPassIntersections;
    }
}

function findConnections(tracks, vias, args) {
    // remove empty tracks
    tracks = tracks.filter(t => t.length > 0);

    // find all connected tracks
    var connections = new Map();
    for(const t of tracks) {
        if (!(t.start in connections))
            connections[t.start] = [t.start.clone(), [t]];
        else
            connections[t.start][1].push(t);
        if (!(t.end in connections))
            connections[t.end] = [t.end.clone(), [t]];
        else
            connections[t.end][1].push(t);
    }

    // remove connections with fewer than 2 tracks
    if (args.smoothnway) {
        // only allow more than 2 tracks if n-way option is set
        for(const pos in connections)
            if (connections[pos][1].length < 2)
                delete connections[pos];
    } else {
        for(const pos in connections)
            if (connections[pos][1].length != 2)
                delete connections[pos];
    }

    // make a kd-tree for faster searching
    const tracktree = kdtree(Object.values(connections));

    // remove connections with vias    
    for(const v of vias) 
        for(const [pos, t] of kdnear(tracktree, v.pos, v.diameter * .5))
            delete connections[pos];

    // todo: kd-tree slow/broken?
    
    // remove junctions with unrelated tracks intersecting them
    //const maxWidth = Math.max(...tracks.map(t => t.width));
    for(const t1 of tracks) {
        // expand the bounding box by the max track width to find all track connections
        //for(const [pos, othertracks] of kdinside(tracktree, t1.bounds(expand = maxWidth * .5))) {
        //    if (!(pos in connections))
        //        continue;
        for(const [pos, tracksHere] of Object.values(connections)) {
            for(const t2 of tracksHere) {
                if (t1.island != t2.island) {
                    if (t1.distanceTo(pos) <= (t1.width + t2.width) * .5) {
                        delete connections[pos];
                        break;
                    }
                }
            }
        }
    }
    return connections;
}

extension.roundtracks = {RoundTracks};
